const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { getTenantContext } = require('./tenantManager');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Global WSS instances
let housekeepingWss;
let stayViewWss;

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

  // Retry logic for database operations (in case DB is still connecting)
  let tenant;
  let retries = 3;
  let lastError;
  
  while (retries > 0) {
    try {
      tenant = await getTenantContext(decoded.propertyCode);
      break; // Success, exit retry loop
    } catch (error) {
      lastError = error;
      retries--;
      
      // Only log network/DNS errors if they persist after all retries
      // Don't spam console with retry attempts for transient issues
      const isNetworkError = error.message?.includes('ENOTFOUND') || 
                            error.message?.includes('getaddrinfo') ||
                            error.message?.includes('MongoServerSelectionError') ||
                            error.code === 'ENOTFOUND';
      
      if (retries > 0) {
        // Wait a bit before retrying (silently for network errors)
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!isNetworkError) {
          console.log(`Retrying tenant context retrieval... (${retries} attempts left)`);
        }
      }
    }
  }
  
  if (!tenant) {
    // Only log if it's not a network/DNS error (those are usually transient)
    const isNetworkError = lastError?.message?.includes('ENOTFOUND') || 
                          lastError?.message?.includes('getaddrinfo') ||
                          lastError?.message?.includes('MongoServerSelectionError') ||
                          lastError?.code === 'ENOTFOUND';
    
    if (!isNetworkError) {
      console.error('Failed to get tenant context after retries:', lastError?.message || lastError);
    }
    // Don't throw error for network issues - just fail silently for WebSocket
    // The main app will work fine, WebSocket will just not connect
    throw new Error('DATABASE_NOT_READY');
  }

  const UserModel = tenant.models.User;
  const user = await UserModel.findById(decoded.userId);

  if (!user || user.status !== 'Active') {
    throw new Error('USER_NOT_FOUND');
  }

  return { tenant, user };
}

function broadcastHousekeepingMessage(payload) {
  if (!housekeepingWss) return;

  const propertyId = payload.property?.toString?.() ?? payload.property;

  housekeepingWss.clients.forEach((client) => {
    if (
      client.readyState === client.OPEN &&
      client.propertyId === propertyId
    ) {
      client.send(JSON.stringify({
        type: 'housekeeping-message',
        payload,
      }));
    }
  });
}

function broadcastStayViewUpdate(payload) {
  if (!stayViewWss) return;

  const propertyId = payload.property?.toString?.() ?? payload.property;

  stayViewWss.clients.forEach((client) => {
    if (
      client.readyState === client.OPEN &&
      client.propertyId === propertyId
    ) {
      client.send(JSON.stringify({
        type: 'stayview:update',
        payload
      }));
    }
  });
}

function broadcastHousekeepingRoomUpdate(payload) {
  if (!housekeepingWss) return;

  const propertyId = payload.property?.toString?.() ?? payload.property;

  housekeepingWss.clients.forEach((client) => {
    if (
      client.readyState === client.OPEN &&
      client.propertyId === propertyId
    ) {
      client.send(JSON.stringify({
        type: 'housekeeping-room-update',
        payload,
      }));
    }
  });
}

// Unified Websocket Initialization
function initWebsockets(server) {
  // Housekeeping WSS
  housekeepingWss = new WebSocketServer({ noServer: true });
  
  // StayView WSS
  stayViewWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (pathname === '/ws/housekeeping') {
      housekeepingWss.handleUpgrade(request, socket, head, (ws) => {
        housekeepingWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/stayview') {
      stayViewWss.handleUpgrade(request, socket, head, (ws) => {
        stayViewWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Housekeeping Connection Logic
  housekeepingWss.on('connection', async (socket, request) => {
    try {
      const { tenant, user } = await authenticateSocket(request);
      socket.tenant = tenant;
      socket.user = user;
      socket.propertyId = tenant.property._id.toString();
      socket.send(JSON.stringify({
        type: 'housekeeping:connected',
        payload: { userName: user.name },
      }));
    } catch (error) {
      // Only log non-network errors (network errors are usually transient DNS issues)
      const isNetworkError = error.message?.includes('ENOTFOUND') || 
                            error.message?.includes('getaddrinfo') ||
                            error.message?.includes('MongoServerSelectionError') ||
                            error.message?.includes('DATABASE_NOT_READY');
      
      if (!isNetworkError) {
        console.error('WS Auth Error:', error.message || error);
      }
      socket.send(JSON.stringify({ type: 'housekeeping:error', message: 'Authentication failed' }));
      return socket.close();
    }

    socket.on('message', async (raw) => {
      if (!socket.tenant || !socket.user) return;
      let data;
      try { data = JSON.parse(raw.toString()); } catch (e) { return; }

      if (data?.type !== 'housekeeping-message') return;
      const text = (data.text || '').trim();
      if (!text) return;

      try {
        const MessageModel = socket.tenant.models.HousekeepingMessage;
        const doc = await MessageModel.create({
          text,
          property: socket.propertyId,
          user: { id: socket.user._id, name: socket.user.name, role: socket.user.role },
        });
        broadcastHousekeepingMessage({ ...mapMessage(doc), property: socket.propertyId });
      } catch (error) {
        console.error('Housekeeping msg error:', error);
      }
    });
  });

  // StayView Connection Logic
  stayViewWss.on('connection', async (socket, request) => {
    try {
      const { tenant, user } = await authenticateSocket(request);
      socket.tenant = tenant;
      socket.user = user;
      socket.propertyId = tenant.property._id.toString();
      socket.send(JSON.stringify({
        type: 'stayview:connected',
        payload: { userName: user.name }
      }));
    } catch (error) {
      // Only log non-network errors (network errors are usually transient DNS issues)
      const isNetworkError = error.message?.includes('ENOTFOUND') || 
                            error.message?.includes('getaddrinfo') ||
                            error.message?.includes('MongoServerSelectionError') ||
                            error.message?.includes('DATABASE_NOT_READY');
      
      if (!isNetworkError) {
        console.error('StayView WS Auth Error:', error.message || error);
      }
      socket.send(JSON.stringify({ type: 'stayview:error', message: 'Authentication failed' }));
      return socket.close();
    }

    socket.on('message', async (raw) => {
      if (!socket.tenant || !socket.user) return;
      let data;
      try { data = JSON.parse(raw.toString()); } catch (e) { return; }

      const Reservations = socket.tenant.models.Reservations;
      try {
        if (data.type === 'stayview:move') {
          const { reservationId, newRoomId, newCheckIn, newCheckOut, oldRoomNumber, operationId } = data.payload;
          
          try {
            // Fetch current reservation
            const reservation = await Reservations.findById(reservationId);
            if (!reservation) {
              throw new Error('Reservation not found');
            }

            const Rooms = socket.tenant.models.Rooms;
            const RoomType = socket.tenant.models.RoomType;
            const updateData = {};
            let oldRoomIds = [];
            let newRoom = null;
            
            // Validate new room exists and is of the same room type
            if (newRoomId) {
              newRoom = await Rooms.findOne({ 
                _id: newRoomId, 
                property: socket.propertyId 
              });
              
              if (!newRoom) {
                throw new Error(`Room with ID ${newRoomId} not found`);
              }
              
              // Validate room type matches reservation room type (unless explicitly allowing different types)
              if (reservation.roomType && newRoom.roomType) {
                const reservationRoomTypeId = reservation.roomType.toString();
                const newRoomTypeId = newRoom.roomType.toString();
                
                if (reservationRoomTypeId !== newRoomTypeId) {
                  // Get room type names for better error message
                  const reservationRoomType = await RoomType.findById(reservation.roomType);
                  const newRoomType = await RoomType.findById(newRoom.roomType);
                  const reservationTypeName = reservationRoomType?.name || 'Unknown';
                  const newTypeName = newRoomType?.name || 'Unknown';
                  
                  throw new Error(`Cannot move reservation to room ${newRoom.roomNumber}. Room type mismatch: Reservation is for ${reservationTypeName}, but room is ${newTypeName}`);
                }
              }
              
              // Check if new room is already occupied by another active reservation
              const conflictingReservation = await Reservations.findOne({
                _id: { $ne: reservationId },
                roomNumbers: newRoomId,
                property: socket.propertyId,
                status: { $in: ['confirmed', 'checked-in'] },
                checkInDate: { $lt: reservation.checkOutDate || new Date() },
                checkOutDate: { $gt: reservation.checkInDate || new Date() }
              });
              
              if (conflictingReservation) {
                throw new Error(`Room ${newRoom.roomNumber} is already occupied by another reservation`);
              }
            }
            
            // Handle room move: if oldRoomNumber is provided, replace only that room
            if (newRoomId && oldRoomNumber) {
              console.log('Moving room:', { oldRoomNumber, newRoomId, reservationId });
              
              // Find the room ID for the old room number
              const oldRoom = await Rooms.findOne({ 
                roomNumber: oldRoomNumber, 
                property: socket.propertyId 
              });
              
              if (!oldRoom) {
                throw new Error(`Room ${oldRoomNumber} not found`);
              }
              
              console.log('Found old room:', { 
                roomId: oldRoom._id.toString(), 
                roomNumber: oldRoom.roomNumber 
              });
              
              // Get current room IDs from reservation
              const currentRoomIds = reservation.roomNumbers || [];
              console.log('Current room IDs in reservation:', currentRoomIds.map(id => id.toString()));
              
              // Check if old room ID is in the reservation
              const oldRoomIdStr = oldRoom._id.toString();
              const roomIndex = currentRoomIds.findIndex(roomId => roomId.toString() === oldRoomIdStr);
              
              if (roomIndex === -1) {
                throw new Error(`Room ${oldRoomNumber} is not assigned to this reservation`);
              }
              
              oldRoomIds = [oldRoom._id];
              // Replace only the specific room in the array
              const updatedRoomIds = currentRoomIds.map((roomId) => 
                roomId.toString() === oldRoomIdStr ? newRoomId : roomId
              );
              
              console.log('Updated room IDs:', updatedRoomIds.map(id => id.toString()));
              updateData.roomNumbers = updatedRoomIds;
            } else if (newRoomId) {
              // If no oldRoomNumber, replace all (backward compatibility)
              // Store all old room IDs to free them
              oldRoomIds = reservation.roomNumbers || [];
              updateData.roomNumbers = [newRoomId];
            }
            
            if (newCheckIn) updateData.checkInDate = new Date(newCheckIn);
            if (newCheckOut) updateData.checkOutDate = new Date(newCheckOut);

            const updatedRes = await Reservations.findByIdAndUpdate(reservationId, updateData, { new: true });
            
            if (!updatedRes) {
              throw new Error('Failed to update reservation in database');
            }
            
            console.log('Reservation moved successfully:', {
              reservationId,
              oldRooms: oldRoomIds,
              newRoom: newRoom?.roomNumber,
              updatedRoomNumbers: updatedRes.roomNumbers
            });
            
            // Update room statuses after reservation is updated
            if (updatedRes) {
              const updatedRooms = [];
              
              // Free all old rooms (set to 'clean' if they were occupied)
              for (const oldRoomId of oldRoomIds) {
                const oldRoom = await Rooms.findById(oldRoomId);
                if (oldRoom && oldRoom.status === 'occupied') {
                  const updatedOldRoom = await Rooms.findByIdAndUpdate(oldRoomId, { status: 'clean' }, { new: true });
                  if (updatedOldRoom) {
                    updatedRooms.push(updatedOldRoom);
                    console.log(`Room ${oldRoom.roomNumber} freed (status set to clean)`);
                  }
                }
              }
              
              // Mark the new room as occupied
              if (newRoom && newRoom.status !== 'occupied') {
                const updatedNewRoom = await Rooms.findByIdAndUpdate(newRoomId, { status: 'occupied' }, { new: true });
                if (updatedNewRoom) {
                  updatedRooms.push(updatedNewRoom);
                  console.log(`Room ${newRoom.roomNumber} marked as occupied`);
                }
              }
              
              // Broadcast room status updates to housekeeping
              if (updatedRooms.length > 0) {
                updatedRooms.forEach(room => {
                  broadcastHousekeepingRoomUpdate({
                    action: 'room-status-updated',
                    room: room,
                    property: socket.propertyId
                  });
                });
              }
              
              broadcastStayViewUpdate({ 
                action: 'move', 
                reservation: updatedRes, 
                property: socket.propertyId,
                operationId // Include operationId for success confirmation
              });
            }
          } catch (error) {
            console.error('StayView move error:', error);
            console.error('Error details:', {
              reservationId,
              newRoomId,
              oldRoomNumber,
              operationId,
              error: error.message,
              stack: error.stack
            });
            // Send error back to client
            socket.send(JSON.stringify({ 
              type: 'stayview:error', 
              payload: { 
                message: error.message || 'Failed to move reservation',
                operationId: operationId || null
              }
            }));
          }
        } else if (data.type === 'stayview:resize') {
          const { reservationId, newCheckIn, newCheckOut, operationId } = data.payload;
          
          try {
            // Fetch current reservation with room type details
            const reservation = await Reservations.findById(reservationId).populate('roomType');
          if (!reservation) {
            throw new Error('Reservation not found');
          }

          const RoomType = socket.tenant.models.RoomType;
          const GuestFolio = socket.tenant.models.GuestFolio;
          const GuestProfiles = socket.tenant.models.GuestProfiles;
          const TaxRule = socket.tenant.models.TaxRule;
          const ServiceFee = socket.tenant.models.ServiceFee;
          
          // Get room type details
          const roomType = await RoomType.findById(reservation.roomType);
          if (!roomType) {
            throw new Error('Room type not found');
          }

          // Calculate new dates and nights
          const oldCheckIn = new Date(reservation.checkInDate);
          const oldCheckOut = new Date(reservation.checkOutDate);
          const newCheckInDate = newCheckIn ? new Date(newCheckIn) : oldCheckIn;
          const newCheckOutDate = newCheckOut ? new Date(newCheckOut) : oldCheckOut;
          
          const oldNights = Math.ceil((oldCheckOut.getTime() - oldCheckIn.getTime()) / (1000 * 60 * 60 * 24));
          const newNights = Math.ceil((newCheckOutDate.getTime() - newCheckInDate.getTime()) / (1000 * 60 * 60 * 24));

          // Recalculate total amount based on room type pricing model
          // Try to use daily rates if available, otherwise use base rates
          const DailyRate = socket.tenant.models.dailyRates;
          const numberOfRooms = reservation.numberOfRooms || 1;
          const totalGuest = reservation.totalGuest || 1;
          
          let newTotalAmount = 0;
          
          // Fetch daily rates for the new date range
          const startDateStr = newCheckInDate.toISOString().split('T')[0];
          const endDateStr = newCheckOutDate.toISOString().split('T')[0];
          
          const dailyRates = await DailyRate.find({
            roomType: reservation.roomType,
            property: socket.propertyId,
            date: { $gte: newCheckInDate, $lt: newCheckOutDate }
          }).sort({ date: 1 });
          
          // If daily rates exist, use them; otherwise use base rates
          if (dailyRates.length > 0) {
            // Calculate using daily rates
            if (roomType.priceModel === 'perPerson') {
              const adultCount = reservation.adultCount || reservation.numberOfAdults || totalGuest;
              const childCount = reservation.childCount || reservation.numberOfChildren || 0;
              
              dailyRates.forEach(rate => {
                const adultTotal = (rate.adultRate || roomType.adultRate || 0) * adultCount;
                const childTotal = (rate.childRate || roomType.childRate || 0) * childCount;
                newTotalAmount += (adultTotal + childTotal);
              });
            } else {
              // perRoom: sum daily rates
              dailyRates.forEach(rate => {
                const baseTotalRooms = (rate.baseRate || roomType.baseRate || 0) * numberOfRooms;
                const baseOccupancy = (roomType.baseOccupancy || 1) * numberOfRooms;
                const extraGuests = Math.max(0, totalGuest - baseOccupancy);
                const extraTotal = (rate.extraGuestRate || roomType.extraGuestRate || 0) * extraGuests;
                newTotalAmount += (baseTotalRooms + extraTotal);
              });
            }
          } else {
            // Fallback to base rates if no daily rates
            if (roomType.priceModel === 'perPerson') {
              // perPerson: (adultRate x adults + childRate x children) x nights
              const adultCount = reservation.adultCount || reservation.numberOfAdults || totalGuest;
              const childCount = reservation.childCount || reservation.numberOfChildren || 0;
              const adultTotal = (roomType.adultRate || 0) * adultCount;
              const childTotal = (roomType.childRate || 0) * childCount;
              newTotalAmount = (adultTotal + childTotal) * newNights;
            } else {
              // perRoom: baseRate x rooms x nights + (extraGuestRate x extra guests x nights)
              const baseTotalRooms = (roomType.baseRate || 0) * numberOfRooms * newNights;
              const baseOccupancy = (roomType.baseOccupancy || 1) * numberOfRooms;
              const extraGuests = Math.max(0, totalGuest - baseOccupancy);
              const extraTotal = (roomType.extraGuestRate || 0) * extraGuests * newNights;
              newTotalAmount = baseTotalRooms + extraTotal;
            }
          }

          // Prepare update data
          const updateData = {
            checkInDate: newCheckInDate,
            checkOutDate: newCheckOutDate,
            totalAmount: newTotalAmount
          };

          // Add meal plan amount if applicable
          if (reservation.mealPlan && reservation.mealPlan !== 'EP' && roomType.MealPlan) {
            const mealPlanRate = roomType.MealPlan[reservation.mealPlan] || 0;
            if (mealPlanRate > 0) {
              let mealPlanGuestCount = 0;
              if (roomType.priceModel === 'perPerson') {
                const adultCount = reservation.adultCount || reservation.numberOfAdults || totalGuest;
                const childCount = reservation.childCount || reservation.numberOfChildren || 0;
                mealPlanGuestCount = adultCount + childCount;
              } else {
                mealPlanGuestCount = totalGuest;
              }
              const mealPlanAmount = mealPlanRate * mealPlanGuestCount * newNights;
              newTotalAmount += mealPlanAmount;
              
              // Update meal plan fields
              updateData.mealPlanAmount = mealPlanAmount;
              updateData.mealPlanNights = newNights;
              updateData.mealPlanGuestCount = mealPlanGuestCount;
              updateData.mealPlanRate = mealPlanRate;
            }
          }

          // Update total amount in updateData after meal plan calculation
          updateData.totalAmount = newTotalAmount;

          // Update reservation
          const updatedRes = await Reservations.findByIdAndUpdate(reservationId, updateData, { new: true });
          if (!updatedRes) {
            throw new Error('Failed to update reservation');
          }

          // Update folio if it exists (update accommodation charges)
          const activeFolio = await GuestFolio.findOne({
            reservationId: reservationId,
            property: socket.propertyId,
            status: 'active'
          });

          if (activeFolio) {
            // Remove old accommodation charges
            activeFolio.items = activeFolio.items.filter(item => 
              !item.description.toLowerCase().includes('accommodation')
            );

            // Add new accommodation charges based on new dates and amount
            const checkIn = newCheckInDate;
            const checkOut = newCheckOutDate;
            const roomTypeName = roomType.name || 'Room';
            const accommodationPerRoom = newTotalAmount / numberOfRooms;

            if (roomType.priceModel === 'perPerson') {
              const adultCount = reservation.adultCount || reservation.numberOfAdults || totalGuest;
              const childCount = reservation.childCount || reservation.numberOfChildren || 0;
              const totalGuests = adultCount + childCount;
              
              activeFolio.items.push({
                description: `Accommodation - ${roomTypeName} (${totalGuests} Guest${totalGuests > 1 ? 's' : ''})`,
                date: checkIn,
                amount: newTotalAmount,
                department: 'Room',
                quantity: 1,
                unitPrice: newTotalAmount
              });
            } else {
              // Get room numbers for per-room charges
              const Rooms = socket.tenant.models.Rooms;
              let finalRoomNumbers = [];
              if (reservation.roomNumbers && reservation.roomNumbers.length > 0) {
                const rooms = await Rooms.find({ _id: { $in: reservation.roomNumbers }, property: socket.propertyId });
                finalRoomNumbers = rooms.map(r => r.roomNumber);
              }

              if (finalRoomNumbers.length > 0) {
                finalRoomNumbers.forEach((roomNum) => {
                  activeFolio.items.push({
                    description: `Accommodation - ${roomTypeName} (Room ${roomNum})`,
                    date: checkIn,
                    amount: accommodationPerRoom,
                    department: 'Room',
                    quantity: 1,
                    unitPrice: accommodationPerRoom
                  });
                });
              } else {
                for (let i = 0; i < numberOfRooms; i++) {
                  activeFolio.items.push({
                    description: `Accommodation - ${roomTypeName} (Room ${i + 1})`,
                    date: checkIn,
                    amount: accommodationPerRoom,
                    department: 'Room',
                    quantity: 1,
                    unitPrice: accommodationPerRoom
                  });
                }
              }
            }

            // Recalculate taxes and service fees based on new total
            const propertyId = socket.propertyId;
            const activeTaxRules = await TaxRule.find({
              property: propertyId,
              isActive: true
            });

            // Remove old tax items and add new ones
            activeFolio.items = activeFolio.items.filter(item => 
              !item.description.toUpperCase().includes('GST') && 
              !item.description.toLowerCase().includes('tax')
            );

            activeTaxRules.forEach(taxRule => {
              if (taxRule.applicableOn === 'room_rate' || taxRule.applicableOn === 'total_amount' || taxRule.applicableOn === 'all') {
                let taxAmount = 0;
                if (taxRule.isPercentage) {
                  taxAmount = (newTotalAmount * taxRule.rate) / 100;
                } else {
                  taxAmount = taxRule.rate;
                }
                
                if (taxAmount > 0) {
                  activeFolio.items.push({
                    description: `${taxRule.name}${taxRule.isPercentage ? ` (${taxRule.rate}%)` : ''}`,
                    date: checkIn,
                    amount: taxAmount,
                    department: 'Room',
                    quantity: 1,
                    unitPrice: taxAmount,
                    tax: 0
                  });
                }
              }
            });

            // Update service fees
            const activeServiceFees = await ServiceFee.find({
              property: propertyId,
              isActive: true
            });

            // Remove old service fee items
            activeFolio.items = activeFolio.items.filter(item => {
              const desc = item.description.toLowerCase();
              return !(
                desc.includes('service fee') || 
                desc.includes('convenience fee') || 
                desc.includes('resort fee') ||
                desc.includes('facility fee')
              );
            });

            const totalGuests = reservation.totalGuest || 1;
            activeServiceFees.forEach(serviceFee => {
              let feeAmount = 0;
              
              if (serviceFee.applicableOn === 'per_night') {
                if (serviceFee.isPercentage) {
                  const accommodationPerNight = newTotalAmount / newNights;
                  feeAmount = (accommodationPerNight * serviceFee.amount) / 100 * newNights;
                } else {
                  feeAmount = serviceFee.amount * newNights;
                }
              } else if (serviceFee.applicableOn === 'per_booking') {
                if (serviceFee.isPercentage) {
                  feeAmount = (newTotalAmount * serviceFee.amount) / 100;
                } else {
                  feeAmount = serviceFee.amount;
                }
              } else if (serviceFee.applicableOn === 'per_person') {
                if (serviceFee.isPercentage) {
                  feeAmount = (newTotalAmount * serviceFee.amount) / 100;
                } else {
                  feeAmount = serviceFee.amount * totalGuests;
                }
              } else if (serviceFee.applicableOn === 'per_person_per_night') {
                if (serviceFee.isPercentage) {
                  const accommodationPerNight = newTotalAmount / newNights;
                  feeAmount = (accommodationPerNight * serviceFee.amount) / 100 * totalGuests * newNights;
                } else {
                  feeAmount = serviceFee.amount * totalGuests * newNights;
                }
              } else if (serviceFee.applicableOn === 'room_rate' || serviceFee.applicableOn === 'total_amount') {
                if (serviceFee.isPercentage) {
                  feeAmount = (newTotalAmount * serviceFee.amount) / 100;
                } else {
                  feeAmount = serviceFee.amount;
                }
              }
              
              if (feeAmount > 0) {
                let description = serviceFee.name;
                if (serviceFee.isPercentage) {
                  description += ` (${serviceFee.amount}%)`;
                }
                if (serviceFee.applicableOn === 'per_night') {
                  description += ` - ${newNights} night${newNights > 1 ? 's' : ''}`;
                } else if (serviceFee.applicableOn === 'per_person') {
                  description += ` - ${totalGuests} guest${totalGuests > 1 ? 's' : ''}`;
                } else if (serviceFee.applicableOn === 'per_person_per_night') {
                  description += ` - ${totalGuests} guest${totalGuests > 1 ? 's' : ''} × ${newNights} night${newNights > 1 ? 's' : ''}`;
                }
                
                activeFolio.items.push({
                  description: description,
                  date: checkIn,
                  amount: feeAmount,
                  department: 'Room',
                  quantity: 1,
                  unitPrice: feeAmount,
                  tax: 0
                });
              }
            });

            // Update folio dates and recalculate balance
            activeFolio.checkIn = checkIn;
            activeFolio.checkOut = checkOut;
            activeFolio.calculateBalance();
            await activeFolio.save();
            
            console.log(`Folio updated for reservation ${reservationId}: New total amount ₹${newTotalAmount.toFixed(2)}`);
          }

          // Update guest profile if it exists
          const guestProfile = await GuestProfiles.findOne({
            reservationId: reservationId,
            property: socket.propertyId
          });

          if (guestProfile) {
            // Find and update the stay record for this reservation
            const stayRecordIndex = guestProfile.records.findIndex(record => {
              const recordCheckIn = new Date(record.checkInDate);
              const recordCheckOut = new Date(record.checkOutDate);
              return recordCheckIn.getTime() === oldCheckIn.getTime() && 
                     recordCheckOut.getTime() === oldCheckOut.getTime();
            });

            if (stayRecordIndex !== -1) {
              // Update existing stay record
              guestProfile.records[stayRecordIndex] = {
                checkInDate: newCheckInDate,
                checkOutDate: newCheckOutDate,
                amount: newTotalAmount
              };
            } else {
              // Add new stay record if not found
              guestProfile.records.push({
                checkInDate: newCheckInDate,
                checkOutDate: newCheckOutDate,
                amount: newTotalAmount
              });
            }

            // Recalculate average stay
            const totalNights = guestProfile.records.reduce((sum, record) => {
              const checkIn = new Date(record.checkInDate);
              const checkOut = new Date(record.checkOutDate);
              const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
              return sum + nights;
            }, 0);
            guestProfile.AverageStay = totalNights / guestProfile.records.length;

            // Update total spend
            guestProfile.totalSpend = guestProfile.records.reduce((sum, record) => sum + (record.amount || 0), 0);
            
            await guestProfile.save();
            console.log(`Guest profile updated for reservation ${reservationId}`);
          }

          broadcastStayViewUpdate({ 
            action: 'resize', 
            reservation: updatedRes, 
            property: socket.propertyId,
            operationId // Include operationId for success confirmation
          });
        } catch (error) {
          console.error('StayView resize error:', error);
          // Send error back to client
          socket.send(JSON.stringify({ 
            type: 'stayview:error', 
            payload: { 
              message: error.message || 'Failed to resize reservation',
              operationId 
            }
          }));
        }
        }
      } catch (error) {
        console.error('StayView logic error:', error);
        socket.send(JSON.stringify({ type: 'stayview:error', message: error.message }));
      }
    });
  });
}

module.exports = {
  initWebsockets,
  broadcastHousekeepingMessage,
  broadcastStayViewUpdate,
  broadcastHousekeepingRoomUpdate
};

