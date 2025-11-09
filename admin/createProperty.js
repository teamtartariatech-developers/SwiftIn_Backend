#!/usr/bin/env node
/**
 * Admin utility for provisioning a new property (tenant) database.
 *
 * Usage:
 *   node admin/createProperty.js --name "Hotel Sunrise" --code HSUN --db-name sunrise_hotel
 *
 * Arguments:
 *   --name        (required) Display name for the property.
 *   --code        (required) Unique property code (will be uppercased).
 *   --db-name     (optional) Override database name (default: sanitised property name).
 *   --metadata    (optional) JSON string with additional metadata (merged into Property.metadata).
 *
 * Requirements:
 *   - MONGO_URI must be defined in Backend/.env (same as the main application).
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { sanitizeCode } = require('../services/tenantManager');
const { schema: propertySchema } = require('../db/auth/properties');

/**
 * Very small argument parser supporting `--key value` pairs.
 */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const current = argv[i];
        if (!current.startsWith('--')) {
            continue;
        }
        const key = current.slice(2);
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for argument ${current}`);
        }
        args[key] = value;
        i += 1;
    }
    return args;
}

function sanitiseDbName(input) {
    const fallback = `property_${Date.now()}`;
    if (!input) return fallback;
    const trimmed = input.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!trimmed) return fallback;
    return trimmed.slice(0, 63);
}

function buildTenantUri(baseUri, dbName) {
    if (!baseUri) {
        throw new Error('MONGO_URI env variable is not defined.');
    }
    const [withoutQuery, query] = baseUri.split('?');
    const parts = withoutQuery.split('/');

    if (parts.length <= 3) {
        const joined = withoutQuery.endsWith('/') ? `${withoutQuery}${dbName}` : `${withoutQuery}/${dbName}`;
        return query ? `${joined}?${query}` : joined;
    }

    parts[parts.length - 1] = dbName;
    const rebuilt = parts.join('/');
    return query ? `${rebuilt}?${query}` : rebuilt;
}

function loadAllModels() {
    const root = path.join(__dirname, '..', 'db');
    const stack = [root];
    const visited = new Set();

    while (stack.length) {
        const current = stack.pop();
        if (visited.has(current)) continue;
        visited.add(current);

        const stats = fs.statSync(current);
        if (stats.isDirectory()) {
            const entries = fs.readdirSync(current);
            entries.forEach((entry) => stack.push(path.join(current, entry)));
        } else if (stats.isFile() && current.endsWith('.js')) {
            // Requiring the file registers its model(s) with mongoose.
            require(current);
        }
    }
}

async function ensureTenantCollections(connection) {
    const modelNames = mongoose.modelNames();
    for (const name of modelNames) {
        const baseModel = mongoose.model(name);
        const tenantModel = connection.model(name, baseModel.schema);

        try {
            await tenantModel.createCollection();
        } catch (error) {
            if (error.codeName !== 'NamespaceExists') {
                throw error;
            }
        }
        await tenantModel.init();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const propertyName = args.name ? args.name.trim() : '';
    const propertyCode = args.code ? sanitizeCode(args.code) : '';

    if (!propertyName) {
        console.error('Missing required argument: --name "Property Name"');
        process.exit(1);
    }
    if (!propertyCode) {
        console.error('Missing required argument: --code PROP');
        process.exit(1);
    }

    let metadata = {};
    if (args.metadata) {
        try {
            metadata = JSON.parse(args.metadata);
        } catch (error) {
            console.warn('Failed to parse metadata JSON. Using empty metadata.', error.message);
        }
    }

    loadAllModels();

    const dbName = sanitiseDbName(args['db-name'] || propertyName);
    const tenantUri = buildTenantUri(process.env.MONGO_URI, dbName);

    console.log(`Provisioning tenant database "${dbName}" using ${tenantUri} ...`);
    let tenantConnection;

    try {
        tenantConnection = mongoose.createConnection(tenantUri);
        await tenantConnection.asPromise();

        const PropertyModel = tenantConnection.model('Property', propertySchema);
        const existing = await PropertyModel.findOne({ code: propertyCode }).lean();
        if (existing) {
            console.error(`Property with code ${propertyCode} already exists in tenant database (id: ${existing._id}).`);
            await tenantConnection.close().catch(() => {});
            process.exit(1);
        }

        await ensureTenantCollections(tenantConnection);

        const property = await PropertyModel.create({
            name: propertyName,
            code: propertyCode,
            metadata: { ...metadata, dbName },
        });
        await PropertyModel.init();

        console.log('');
        console.log('✅ Property provisioned successfully');
        console.log(`   Property ID : ${property._id.toString()}`);
        console.log(`   Property Code: ${property.code}`);
        console.log(`   Database     : ${dbName}`);
    } catch (error) {
        console.error('Failed to provision property:', error.message);
        if (tenantConnection) {
            try {
                await tenantConnection.dropDatabase();
            } catch (_) {
                // ignore cleanup errors
            }
        }
        process.exitCode = 1;
    } finally {
        if (tenantConnection) {
            await tenantConnection.close().catch(() => {});
        }
    }
}

main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
});

