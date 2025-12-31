const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    
    if (!mongoUri) {
      console.error('❌ MONGO_URI environment variable is not set!');
      console.error('   Please check your .env file and ensure MONGO_URI is configured.');
      process.exit(1);
    }

    // Extract hostname from URI for better error messages
    const uriMatch = mongoUri.match(/mongodb\+srv:\/\/(?:[^:]+:[^@]+@)?([^/]+)/);
    const hostname = uriMatch ? uriMatch[1] : 'unknown';

    console.log(`🔄 Attempting to connect to MongoDB Atlas...`);
    console.log(`   Hostname: ${hostname}`);

    // Set connection options with optimized pooling for performance
    const options = {
      serverSelectionTimeoutMS: 10000, // 10 seconds timeout
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      w: 'majority',
      // Connection pool optimization for high performance
      maxPoolSize: 50, // Maximum number of connections in the pool
      minPoolSize: 5, // Minimum number of connections to maintain
      maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
      // Buffer settings for better performance
      bufferCommands: false, // Disable mongoose buffering
      // Read preference for better performance
      readPreference: 'primaryPreferred', // Prefer primary but allow reads from secondaries
    };

    await mongoose.connect(mongoUri, options);
    console.log('✅ MongoDB Connected successfully!');
    } catch (error) {
        // Check if this is a network/DNS error (might be transient)
        const isNetworkError = error.message?.includes('ENOTFOUND') || 
                              error.message?.includes('getaddrinfo') ||
                              error.message?.includes('MongoServerSelectionError') ||
                              error.name === 'MongoServerSelectionError';
        
        if (isNetworkError) {
            // For network errors, show a concise message and retry logic
            console.error('\n⚠️  MongoDB connection failed (Network/DNS issue)');
            console.error(`   Hostname: ${hostname}`);
            console.error('   This might be a temporary network issue.');
            console.error('   The application will continue to retry in the background.');
            console.error('\n💡 Quick checks:');
            console.error('   - Internet connection');
            console.error('   - MongoDB Atlas cluster status (not paused)');
            console.error('   - DNS resolution');
            console.error('\n   Note: If the main connection works, WebSocket may show errors but HTTP API will function normally.\n');
        } else {
            // For other errors, show detailed troubleshooting
            console.error('\n❌ MongoDB connection error:');
            console.error(`   Error: ${error.message}`);
            
            if (error.message.includes('authentication')) {
                console.error('\n🔍 Authentication Failed - Troubleshooting Steps:');
                console.error('   1. Verify MongoDB Atlas username and password');
                console.error('   2. Check if database user has proper permissions');
                console.error('   3. Verify IP whitelist in MongoDB Atlas Network Access');
            } else if (error.message.includes('timeout')) {
                console.error('\n🔍 Connection Timeout - Troubleshooting Steps:');
                console.error('   1. Check internet connection speed');
                console.error('   2. Verify MongoDB Atlas cluster is accessible');
                console.error('   3. Check firewall settings');
            }
            
            console.error('\n💡 For MongoDB Atlas:');
            console.error('   - Ensure cluster is not paused');
            console.error('   - Check Network Access IP whitelist');
            console.error('   - Verify database user credentials\n');
        }
        
        // Only exit on non-network errors (network errors might be transient)
        // For network errors, let the app continue - retries will happen automatically
        if (!isNetworkError) {
            process.exit(1);
        } else {
            // Log but don't exit - allow app to continue and retry
            console.error('   Continuing with application startup... (will retry on next request)\n');
        }
    }
};

module.exports = connectDB;
