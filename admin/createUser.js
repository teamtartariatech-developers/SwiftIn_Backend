#!/usr/bin/env node
/**
 * Admin utility for creating a user in an existing property.
 *
 * Usage:
 *   node admin/createUser.js --property-code DEMO --name "Jane Doe" \
 *     --email jane@example.com --password StrongPass!234 --role "Front Desk" \
 *     --modules '["front-office","guest-management"]'
 *
 * Arguments:
 *   --property-code  (required) Property code to attach the user to (case-insensitive).
 *   --email          (required) User email (unique per property).
 *   --password       (required) Plaintext password (hashed automatically).
 *   --name           (required) Display name.
 *   --role           (optional) Role name; defaults to 'Front Desk'.
 *   --modules        (optional) JSON array or comma separated modules; defaults to role modules.
 *   --status         (optional) 'Active' | 'Inactive' (default Active).
 *
 * Requirements:
 *   - MONGO_URI must be defined in Backend/.env (same as the main application).
 */

const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { sanitizeCode, getTenantContext } = require('../services/tenantManager');
const { ROLE_MODULES, MODULE_OPTIONS } = require('../db/auth/user');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const current = argv[i];
        if (!current.startsWith('--')) continue;
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

function parseModules(input) {
    if (!input) return undefined;
    let modules;
    try {
        if (input.trim().startsWith('[')) {
            modules = JSON.parse(input);
        } else {
            modules = input.split(',').map((item) => item.trim()).filter(Boolean);
        }
    } catch (error) {
        throw new Error(`Unable to parse modules: ${error.message}`);
    }

    const invalid = modules.filter((module) => !MODULE_OPTIONS.includes(module));
    if (invalid.length) {
        throw new Error(`Invalid modules: ${invalid.join(', ')}. Valid options: ${MODULE_OPTIONS.join(', ')}`);
    }

    return modules;
}

async function ensurePrimaryConnection() {
    if (mongoose.connection.readyState === 1) {
        return;
    }

    const uri = process.env.MONGO_URI;
    if (!uri) {
        throw new Error('MONGO_URI env variable is not defined.');
    }

    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(uri);
    } else if (mongoose.connection.readyState === 2) {
        await mongoose.connection.asPromise();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const propertyCode = args['property-code'] ? sanitizeCode(args['property-code']) : '';
    const email = args.email ? args.email.trim().toLowerCase() : '';
    const password = args.password ? args.password.trim() : '';
    const name = args.name ? args.name.trim() : '';
    const role = args.role ? args.role.trim() : 'Front Desk';
    const status = args.status ? args.status.trim() : 'Active';

    if (!propertyCode) {
        console.error('Missing required argument: --property-code CODE');
        process.exit(1);
    }
    if (!email) {
        console.error('Missing required argument: --email user@example.com');
        process.exit(1);
    }
    if (!password) {
        console.error('Missing required argument: --password P@ssword1');
        process.exit(1);
    }
    if (!name) {
        console.error('Missing required argument: --name "User Name"');
        process.exit(1);
    }

    if (!ROLE_MODULES[role] && role !== 'Admin') {
        console.warn(`Unrecognised role "${role}". Valid roles: ${Object.keys(ROLE_MODULES).join(', ')}`);
    }

    let modules;
    try {
        modules = parseModules(args.modules);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    try {
        await ensurePrimaryConnection();

        const tenantContext = await getTenantContext(propertyCode);
        const property = tenantContext.property;
        const UserModel = tenantContext.models.User;

        if (!property) {
            console.error(`No property found with code ${propertyCode}.`);
            process.exit(1);
        }

        const normalizedModules =
            modules ?? (ROLE_MODULES[role] ? [...ROLE_MODULES[role]] : []);

        const user = new UserModel({
            name,
            email,
            password,
            property: property._id,
            role,
            modules: normalizedModules,
            status,
        });

        await user.save();
        await UserModel.init();

        console.log('');
        console.log('✅ User created successfully');
        console.log(`   Property : ${property.name} (${property.code})`);
        console.log(`   User ID  : ${user._id.toString()}`);
        console.log(`   Email    : ${user.email}`);
        console.log(`   Role     : ${user.role}`);
        console.log(`   Modules  : ${(user.modules || []).join(', ')}`);
        console.log(`   Database : ${tenantContext.dbName}`);
    } catch (error) {
        if (error.code === 11000) {
            console.error('A user with that email already exists for this property.');
        } else if (error.message === 'TENANT_PROPERTY_NOT_FOUND') {
            console.error(`No tenant database found for property code ${propertyCode}.`);
        } else if (error.message === 'PRIMARY_DB_NOT_CONNECTED') {
            console.error(
                'Unable to connect to primary MongoDB instance. Check MONGO_URI and network connectivity.',
            );
        } else {
            console.error('Failed to create user:', error.message);
        }
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
}

main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
});

