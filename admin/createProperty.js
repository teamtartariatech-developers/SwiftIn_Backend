#!/usr/bin/env node
/**
 * Admin utility for provisioning a new property (tenant) database or updating existing properties.
 *
 * CREATE MODE:
 *   node admin/createProperty.js --name "Hotel Sunrise" --code HSUN --db-name sunrise_hotel
 *
 * UPDATE MODE:
 *   node admin/createProperty.js --update --code HSUN --allowedrooms 30
 *
 * Arguments:
 *   --update      (optional) Update mode - updates existing property instead of creating new one.
 *   --name        (required for create) Display name for the property.
 *   --code        (required) Unique property code (will be uppercased).
 *   --db-name     (optional) Override database name (default: sanitised property name).
 *   --metadata    (optional) JSON string with additional metadata (merged into Property.metadata).
 *   --allowedrooms (optional) Number of allowed rooms (default: 15 for create, unchanged for update).
 *
 * Requirements:
 *   - MONGO_URI must be defined in Backend/.env (same as the main application).
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { sanitizeCode, dbNameFromCode } = require('../services/tenantManager');
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
        // For flags like --update that don't need a value, set to true
        if (!value || value.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = value;
            i += 1;
        }
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

async function findPropertyDatabase(propertyCode) {
    const normalizedCode = sanitizeCode(propertyCode);
    const defaultDbName = dbNameFromCode(normalizedCode);
    
    // Connect to MongoDB first
    const primaryUri = process.env.MONGO_URI;
    if (!primaryUri) {
        throw new Error('MONGO_URI env variable is not defined.');
    }
    
    // Connect to primary database to list all databases
    const primaryConnection = mongoose.createConnection(primaryUri);
    await primaryConnection.asPromise();
    
    // Load models before searching
    loadAllModels();
    
    try {
        const adminDb = primaryConnection.db.admin();
        const { databases } = await adminDb.listDatabases();
        
        // Try default database first
        const defaultUri = buildTenantUri(primaryUri, defaultDbName);
        let testConnection = mongoose.createConnection(defaultUri);
        await testConnection.asPromise();
        
        try {
            const PropertyModel = testConnection.model('Property', propertySchema);
            const property = await PropertyModel.findOne({ code: normalizedCode }).lean();
            if (property) {
                await testConnection.close();
                await primaryConnection.close();
                return { dbName: defaultDbName, property };
            }
        } catch (error) {
            // Property not found in default DB, continue searching
        }
        await testConnection.close();
        
        // Search through all databases
        for (const { name } of databases) {
            if (name === 'admin' || name === 'config' || name === 'local' || name === defaultDbName) {
                continue;
            }
            
            const testUri = buildTenantUri(primaryUri, name);
            testConnection = mongoose.createConnection(testUri);
            await testConnection.asPromise();
            
            try {
                const PropertyModel = testConnection.model('Property', propertySchema);
                const property = await PropertyModel.findOne({ code: normalizedCode }).lean();
                if (property) {
                    await testConnection.close();
                    await primaryConnection.close();
                    return { dbName: name, property };
                }
            } catch (error) {
                // Property not found, continue
            }
            await testConnection.close();
        }
        
        await primaryConnection.close();
        return null;
    } catch (error) {
        await primaryConnection.close();
        throw error;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const isUpdateMode = args.update === true;
    const propertyCode = args.code ? sanitizeCode(args.code) : '';

    if (!propertyCode) {
        console.error('Missing required argument: --code PROP');
        process.exit(1);
    }

    // UPDATE MODE
    if (isUpdateMode) {
        try {
            console.log(`Searching for property with code ${propertyCode}...`);
            const result = await findPropertyDatabase(propertyCode);
            
            if (!result) {
                console.error(`Property with code ${propertyCode} not found in any database.`);
                process.exit(1);
            }
            
            const { dbName, property } = result;
            const tenantUri = buildTenantUri(process.env.MONGO_URI, dbName);
            const tenantConnection = mongoose.createConnection(tenantUri);
            await tenantConnection.asPromise();
            
            try {
                loadAllModels();
                const PropertyModel = tenantConnection.model('Property', propertySchema);
                
                const updateData = {};
                
                if (args.allowedrooms !== undefined) {
                    const parsed = parseInt(args.allowedrooms, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        updateData.allowedrooms = parsed;
                    } else {
                        console.warn('Invalid allowedrooms value. Skipping update.');
                    }
                }
                
                if (args.name) {
                    updateData.name = args.name.trim();
                }
                
                if (args.metadata) {
                    try {
                        const metadata = JSON.parse(args.metadata);
                        updateData.metadata = { ...property.metadata, ...metadata };
                    } catch (error) {
                        console.warn('Failed to parse metadata JSON. Skipping metadata update.', error.message);
                    }
                }
                
                if (Object.keys(updateData).length === 0) {
                    console.log('No fields to update. Use --allowedrooms, --name, or --metadata to update.');
                    await tenantConnection.close();
                    process.exit(0);
                }
                
                const updatedProperty = await PropertyModel.findOneAndUpdate(
                    { _id: property._id },
                    updateData,
                    { new: true, runValidators: true }
                );
                
                console.log('');
                console.log('✅ Property updated successfully');
                console.log(`   Property ID : ${updatedProperty._id.toString()}`);
                console.log(`   Property Code: ${updatedProperty.code}`);
                console.log(`   Database     : ${dbName}`);
                if (updateData.allowedrooms !== undefined) {
                    console.log(`   Allowed Rooms: ${updatedProperty.allowedrooms}`);
                }
            } finally {
                await tenantConnection.close();
            }
        } catch (error) {
            console.error('Failed to update property:', error.message);
            process.exitCode = 1;
        }
        return;
    }

    // CREATE MODE
    const propertyName = args.name ? args.name.trim() : '';
    if (!propertyName) {
        console.error('Missing required argument: --name "Property Name"');
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

    let allowedrooms = 15;
    if (args.allowedrooms) {
        const parsed = parseInt(args.allowedrooms, 10);
        if (!isNaN(parsed) && parsed > 0) {
            allowedrooms = parsed;
        } else {
            console.warn('Invalid allowedrooms value. Using default 15.');
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
            console.error('Use --update flag to update an existing property.');
            await tenantConnection.close().catch(() => {});
            process.exit(1);
        }

        await ensureTenantCollections(tenantConnection);

        const property = await PropertyModel.create({
            name: propertyName,
            code: propertyCode,
            metadata: { ...metadata, dbName },
            allowedrooms: allowedrooms,
        });
        await PropertyModel.init();

        console.log('');
        console.log('✅ Property provisioned successfully');
        console.log(`   Property ID : ${property._id.toString()}`);
        console.log(`   Property Code: ${property.code}`);
        console.log(`   Database     : ${dbName}`);
        console.log(`   Allowed Rooms: ${property.allowedrooms}`);
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

