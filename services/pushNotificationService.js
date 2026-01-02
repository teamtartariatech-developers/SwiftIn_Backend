const admin = require('firebase-admin');

let firebaseApp = null;

/**
 * Initialize Firebase Admin SDK
 * Should be called once at application startup
 */
function initializeFirebase() {
    if (firebaseApp) {
        return firebaseApp; // Already initialized
    }

    try {
        // Initialize with service account credentials from environment variable
        // FIREBASE_SERVICE_ACCOUNT should be a JSON string of the service account key
        const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
        
        if (!serviceAccountJson) {
            console.warn('FIREBASE_SERVICE_ACCOUNT environment variable not set. Push notifications will be disabled.');
            return null;
        }

        const serviceAccount = JSON.parse(serviceAccountJson);
        
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });

        console.log('Firebase Admin SDK initialized successfully');
        return firebaseApp;
    } catch (error) {
        console.error('Error initializing Firebase Admin SDK:', error);
        return null;
    }
}

/**
 * Send push notification to a single FCM token
 */
async function sendNotification(token, title, body, data = {}) {
    if (!firebaseApp) {
        console.warn('Firebase not initialized. Cannot send notification.');
        return { success: false, error: 'Firebase not initialized' };
    }

    if (!token) {
        return { success: false, error: 'FCM token is required' };
    }

    const message = {
        notification: {
            title: title,
            body: body,
        },
        data: {
            ...data,
            // Ensure all data values are strings
            timestamp: new Date().toISOString(),
        },
        token: token,
        android: {
            priority: 'high',
            notification: {
                channelId: 'housekeeping_messages',
                sound: 'default',
            },
        },
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1,
                },
            },
        },
    };

    try {
        const response = await admin.messaging().send(message);
        return { success: true, messageId: response };
    } catch (error) {
        console.error('Error sending push notification:', error);
        
        // Handle invalid token errors
        if (error.code === 'messaging/invalid-registration-token' || 
            error.code === 'messaging/registration-token-not-registered') {
            return { success: false, error: 'Invalid token', shouldRemoveToken: true };
        }
        
        return { success: false, error: error.message };
    }
}

/**
 * Send push notifications to multiple FCM tokens
 */
async function sendNotificationToMultiple(tokens, title, body, data = {}) {
    if (!firebaseApp) {
        console.warn('Firebase not initialized. Cannot send notifications.');
        return { success: false, error: 'Firebase not initialized' };
    }

    if (!tokens || tokens.length === 0) {
        return { success: false, error: 'No tokens provided' };
    }

    // Filter out null/undefined tokens
    const validTokens = tokens.filter(token => token && token.trim().length > 0);
    
    if (validTokens.length === 0) {
        return { success: false, error: 'No valid tokens provided' };
    }

    const message = {
        notification: {
            title: title,
            body: body,
        },
        data: {
            ...data,
            timestamp: new Date().toISOString(),
        },
        android: {
            priority: 'high',
            notification: {
                channelId: 'housekeeping_messages',
                sound: 'default',
            },
        },
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1,
                },
            },
        },
        tokens: validTokens,
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        
        // Check for failed tokens that should be removed
        const invalidTokens = [];
        if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const errorCode = resp.error?.code;
                    if (errorCode === 'messaging/invalid-registration-token' || 
                        errorCode === 'messaging/registration-token-not-registered') {
                        invalidTokens.push(validTokens[idx]);
                    }
                }
            });
        }

        return {
            success: response.successCount > 0,
            successCount: response.successCount,
            failureCount: response.failureCount,
            invalidTokens: invalidTokens,
        };
    } catch (error) {
        console.error('Error sending multicast push notifications:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Send push notification to all users in a property
 */
async function sendNotificationToPropertyUsers(Users, propertyId, title, body, data = {}, excludeUserId = null) {
    try {
        // Find all active users in the property with FCM tokens
        const query = { 
            property: propertyId, 
            status: 'Active',
            fcmToken: { $exists: true, $ne: null, $ne: '' }
        };
        
        if (excludeUserId) {
            query._id = { $ne: excludeUserId }; // Exclude the user who sent the message
        }

        const users = await Users.find(query).select('fcmToken').lean();
        const tokens = users.map(user => user.fcmToken).filter(token => token);

        if (tokens.length === 0) {
            return { success: false, error: 'No users with FCM tokens found' };
        }

        return await sendNotificationToMultiple(tokens, title, body, data);
    } catch (error) {
        console.error('Error sending notifications to property users:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeFirebase,
    sendNotification,
    sendNotificationToMultiple,
    sendNotificationToPropertyUsers,
};

