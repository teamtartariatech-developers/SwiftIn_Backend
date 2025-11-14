const mongoose = require('mongoose');

const cachedTenants = new Map();
const baseSchemas = new Map();
const codeToDbName = new Map();

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);

// Load base schemas without registering models globally.
// Use require to fetch the schema definitions.
function loadBaseSchema(modelName) {
    if (baseSchemas.has(modelName)) {
        return baseSchemas.get(modelName);
    }

    // Mapping model names to schema exports
    const schemaMap = {
        Property: require('../db/auth/properties').schema,
        User: require('../db/auth/user').schema,
        Reservations: require('../db/foundation/reservations').schema,
        RoomType: require('../db/foundation/roomType').schema,
        Rooms: require('../db/foundation/rooms').schema,
        dailyRates: require('../db/dailyRates').schema,
        InventoryBlock: require('../db/inventoryBlocks').schema,
        GuestProfiles: require('../db/guestProfiles').schema,
        Campaign: require('../db/guestManagement/campaign').schema,
        Conversation: require('../db/guestManagement/conversation').schema,
        Message: require('../db/guestManagement/message').schema,
        MessageTemplate: require('../db/guestManagement/messageTemplate').schema,
        EmailTemplate: require('../db/guestManagement/emailTemplate').schema,
        Review: require('../db/guestManagement/reputation').schema,
        GuestFolio: require('../db/billingFinance/guestFolio').schema,
        Bill: require('../db/billingFinance/bill').schema,
        PropertyDetails: require('../db/settings/propertyDetails').schema,
        EmailIntegration: require('../db/settings/emailIntegration').schema,
        TaxRule: require('../db/settings/taxesFees').TaxRule.schema,
        ServiceFee: require('../db/settings/taxesFees').ServiceFee.schema,
        AISettings: require('../db/settings/aiSettings').schema,
        InventoryBlockRoom: require('../db/inventoryBlocks').schema,
        ReportSnapshot: require('../db/reports/reportSnapshot').schema,
        Promotion: require('../db/promotion').schema,
        MaintenanceLog: require('../db/housekeeping/maintenanceLog').schema,
        HousekeepingMessage: require('../db/housekeeping/message').schema,
    };

    const schema = schemaMap[modelName];
    if (!schema) {
        throw new Error(`Schema not registered in tenant manager: ${modelName}`);
    }

    baseSchemas.set(modelName, schema);
    return schema;
}

function sanitizeCode(code) {
    return code.toUpperCase().trim();
}

function dbNameFromCode(code) {
    return sanitizeCode(code)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        || `property_${Date.now()}`;
}

function registerModels(connection) {
    const models = {};
    [
        'Property',
        'User',
        'Reservations',
        'RoomType',
        'Rooms',
        'dailyRates',
        'InventoryBlock',
        'GuestProfiles',
        'Campaign',
        'Conversation',
        'Message',
        'MessageTemplate',
        'EmailTemplate',
        'Review',
        'GuestFolio',
        'Bill',
        'PropertyDetails',
        'EmailIntegration',
        'TaxRule',
        'ServiceFee',
        'AISettings',
        'ReportSnapshot',
        'Promotion',
        'MaintenanceLog',
        'HousekeepingMessage',
    ].forEach((name) => {
        if (!connection.models[name]) {
            const baseSchema = loadBaseSchema(name);
            connection.model(name, baseSchema);
        }
        models[name] = connection.models[name];
    });
    return models;
}

function getOrCreateTenant(dbName) {
    if (!cachedTenants.has(dbName)) {
        const connection = mongoose.connection.useDb(dbName, { useCache: true });
        cachedTenants.set(dbName, {
            connection,
            models: registerModels(connection),
            property: null,
        });
    }
    return cachedTenants.get(dbName);
}

async function tryResolveInDatabase(dbName, normalizedCode) {
    try {
        const tenant = getOrCreateTenant(dbName);
        const propertyModel = tenant.models.Property;
        const property = await propertyModel.findOne({ code: normalizedCode });
        if (!property) {
            return null;
        }
        tenant.property = property;
        codeToDbName.set(normalizedCode, dbName);
        return { dbName, tenant };
    } catch (error) {
        // NamespaceNotFound (code 26) means the collection/database does not exist yet.
        if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') {
            return null;
        }
        throw error;
    }
}

async function resolveTenant(normalizedCode) {
    const cachedDbName = codeToDbName.get(normalizedCode);
    if (cachedDbName) {
        const tenant = getOrCreateTenant(cachedDbName);
        return { dbName: cachedDbName, tenant };
    }

    const defaultDbName = dbNameFromCode(normalizedCode);
    let result = await tryResolveInDatabase(defaultDbName, normalizedCode);
    if (result) {
        return result;
    }

    const primaryDb = mongoose.connection?.db;
    if (!primaryDb) {
        throw new Error('PRIMARY_DB_NOT_CONNECTED');
    }

    const { databases } = await primaryDb.admin().listDatabases();
    for (const { name } of databases) {
        if (SYSTEM_DATABASES.has(name) || name === defaultDbName) {
            continue;
        }
        result = await tryResolveInDatabase(name, normalizedCode);
        if (result) {
            return result;
        }
    }

    throw new Error('TENANT_PROPERTY_NOT_FOUND');
}

async function getTenantContext(propertyCode) {
    if (!propertyCode) {
        throw new Error('TENANT_CODE_REQUIRED');
    }

    const normalizedCode = sanitizeCode(propertyCode);
    const { dbName, tenant } = await resolveTenant(normalizedCode);

    let property = tenant.property;
    if (!property || property.code !== normalizedCode) {
        const propertyModel = tenant.models.Property;
        property = await propertyModel.findOne({ code: normalizedCode });
        if (!property) {
            codeToDbName.delete(normalizedCode);
            cachedTenants.delete(dbName);
            throw new Error('TENANT_PROPERTY_NOT_FOUND');
        }
        tenant.property = property;
    }

    const preferredDbName =
        typeof property.metadata?.dbName === 'string'
            ? property.metadata.dbName.trim().toLowerCase()
            : null;

    if (preferredDbName && preferredDbName !== dbName) {
        const preferred = await tryResolveInDatabase(preferredDbName, normalizedCode);
        if (preferred) {
            return {
                code: normalizedCode,
                dbName: preferred.dbName,
                connection: preferred.tenant.connection,
                models: preferred.tenant.models,
                property: preferred.tenant.property,
            };
        }
    }

    return {
        code: normalizedCode,
        dbName,
        connection: tenant.connection,
        models: tenant.models,
        property,
    };
}

module.exports = {
    sanitizeCode,
    dbNameFromCode,
    getTenantContext,
};

