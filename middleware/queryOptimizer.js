// Query optimization utilities for MongoDB
// Ensures all queries use best practices for performance

/**
 * Optimize Mongoose query with lean() and selective fields
 * @param {Query} query - Mongoose query object
 * @param {Array} fields - Fields to select (optional)
 * @returns {Query} Optimized query
 */
function optimizeQuery(query, fields = null) {
    // Use lean() for read-only operations (faster, returns plain objects)
    let optimized = query.lean();
    
    // Select only required fields if specified
    if (fields && Array.isArray(fields) && fields.length > 0) {
        const selectObj = {};
        fields.forEach(field => {
            selectObj[field] = 1;
        });
        optimized = optimized.select(selectObj);
    }
    
    return optimized;
}

/**
 * Optimize find query with common patterns
 * @param {Model} Model - Mongoose model
 * @param {Object} filter - Query filter
 * @param {Object} options - Options (fields, sort, limit, skip)
 * @returns {Promise} Query result
 */
async function optimizedFind(Model, filter, options = {}) {
    let query = Model.find(filter);
    
    // Apply field selection
    if (options.fields) {
        query = query.select(options.fields);
    }
    
    // Apply sorting
    if (options.sort) {
        query = query.sort(options.sort);
    }
    
    // Apply pagination
    if (options.limit) {
        query = query.limit(options.limit);
    }
    if (options.skip) {
        query = query.skip(options.skip);
    }
    
    // Use lean() for read-only
    if (options.lean !== false) {
        query = query.lean();
    }
    
    return query.exec();
}

/**
 * Optimize findOne query
 * @param {Model} Model - Mongoose model
 * @param {Object} filter - Query filter
 * @param {Object} options - Options (fields, lean)
 * @returns {Promise} Query result
 */
async function optimizedFindOne(Model, filter, options = {}) {
    let query = Model.findOne(filter);
    
    // Apply field selection
    if (options.fields) {
        query = query.select(options.fields);
    }
    
    // Use lean() for read-only
    if (options.lean !== false) {
        query = query.lean();
    }
    
    return query.exec();
}

/**
 * Optimize findById query
 * @param {Model} Model - Mongoose model
 * @param {String} id - Document ID
 * @param {Object} options - Options (fields, lean)
 * @returns {Promise} Query result
 */
async function optimizedFindById(Model, id, options = {}) {
    let query = Model.findById(id);
    
    // Apply field selection
    if (options.fields) {
        query = query.select(options.fields);
    }
    
    // Use lean() for read-only
    if (options.lean !== false) {
        query = query.lean();
    }
    
    return query.exec();
}

/**
 * Batch find with optimized queries
 * @param {Array} queries - Array of {Model, filter, options}
 * @returns {Promise} Array of results
 */
async function batchFind(queries) {
    const promises = queries.map(({ Model, filter, options }) => 
        optimizedFind(Model, filter, options)
    );
    return Promise.all(promises);
}

/**
 * Check if query should use lean()
 * @param {String} operation - Operation type (read/write)
 * @returns {Boolean}
 */
function shouldUseLean(operation = 'read') {
    return operation === 'read';
}

module.exports = {
    optimizeQuery,
    optimizedFind,
    optimizedFindOne,
    optimizedFindById,
    batchFind,
    shouldUseLean,
};

