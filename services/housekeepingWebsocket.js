const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { getTenantContext } = require('./tenantManager');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

let wss;

const mapMessage = (doc) => ({
  id: doc._id,
  text: doc.text,
  createdAt: doc.createdAt,
  userId: doc.user?.id,
  userName: doc.user?.name,
  userRole: doc.user?.role,
});

async function authenticateSocket(request) {
  const url = new URL(request.url, `ws://${request.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    throw new Error('TOKEN_REQUIRED');
  }

  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded.propertyCode) {
    throw new Error('INVALID_TOKEN');
  }

  const tenant = await getTenantContext(decoded.propertyCode);
  const UserModel = tenant.models.User;
  const user = await UserModel.findById(decoded.userId);

  if (!user || user.status !== 'Active') {
    throw new Error('USER_NOT_FOUND');
  }

  return { tenant, user };
}

function broadcastHousekeepingMessage(payload) {
  if (!wss) {
    return;
  }

  const propertyId = payload.property?.toString?.() ?? payload.property;

  wss.clients.forEach((client) => {
    if (
      client.readyState === client.OPEN &&
      client.propertyId === propertyId
    ) {
      client.send(
        JSON.stringify({
          type: 'housekeeping-message',
          payload,
        })
      );
    }
  });
}

function initHousekeepingWebsocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/ws/housekeeping',
  });

  wss.on('connection', async (socket, request) => {
    try {
      const { tenant, user } = await authenticateSocket(request);
      socket.tenant = tenant;
      socket.user = user;
      socket.propertyId = tenant.property._id.toString();
      socket.send(
        JSON.stringify({
          type: 'housekeeping:connected',
          payload: { userName: user.name },
        })
      );
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: 'housekeeping:error',
          message: 'Authentication failed',
        })
      );
      return socket.close();
    }

    socket.on('message', async (raw) => {
      if (!socket.tenant || !socket.user) {
        return;
      }

      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (error) {
        return;
      }

      if (data?.type !== 'housekeeping-message') {
        return;
      }

      const text = (data.text || '').trim();
      if (!text) {
        return;
      }

      try {
        const MessageModel = socket.tenant.models.HousekeepingMessage;
        const doc = await MessageModel.create({
          text,
          property: socket.propertyId,
          user: {
            id: socket.user._id,
            name: socket.user.name,
            role: socket.user.role,
          },
        });

        broadcastHousekeepingMessage({
          ...mapMessage(doc),
          property: socket.propertyId,
        });
      } catch (error) {
        console.error('Failed to persist housekeeping message:', error);
        socket.send(
          JSON.stringify({
            type: 'housekeeping:error',
            message: 'Unable to send message right now.',
          })
        );
      }
    });
  });
}

module.exports = {
  initHousekeepingWebsocket,
  broadcastHousekeepingMessage,
};

