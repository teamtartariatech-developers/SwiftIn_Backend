const EXCLUDED_RESERVATION_STATUSES = new Set([
    'cancelled',
    'canceled',
    'no-show',
    'noshow',
    'draft'
]);

const RANGE_LABELS = {
    today: 'Today',
    '7days': 'Last 7 Days',
    '30days': 'Last 30 Days',
    mtd: 'Month to Date',
    custom: 'Custom Range'
};

const toStartOfDayUTC = (input) => {
    const date = new Date(input);
    date.setUTCHours(0, 0, 0, 0);
    return date;
};

const addDaysUTC = (date, days) => {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
};

const formatDateKey = (date) => {
    return date.toISOString().split('T')[0];
};

const normalizeDepartment = (value) => {
    if (!value) {
        return 'Other';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'room' || normalized === 'rooms') {
        return 'Room';
    }
    if (normalized === 'f&b' || normalized === 'fnb' || normalized === 'fb') {
        return 'F&B';
    }
    if (normalized === 'spa') {
        return 'Spa';
    }
    if (normalized === 'laundry') {
        return 'Laundry';
    }
    return 'Other';
};

const toNumber = (value, fallback = 0) => {
    if (value === null || value === undefined) {
        return fallback;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

const getRoomCount = (reservation) => {
    const declaredRooms = toNumber(reservation.numberOfRooms, 0);
    if (declaredRooms > 0) {
        return declaredRooms;
    }
    if (Array.isArray(reservation.roomNumbers) && reservation.roomNumbers.length > 0) {
        return reservation.roomNumbers.length;
    }
    return 1;
};

const validateCustomDates = (start, end) => {
    if (!start || !end) {
        throw new Error('Both start and end dates are required for custom range.');
    }
    const startDate = toStartOfDayUTC(start);
    const endDate = toStartOfDayUTC(end);
    if (startDate > endDate) {
        throw new Error('Start date cannot be after end date.');
    }
    return { startDate, endDate };
};

const resolveDateRange = (range = '7days', start, end) => {
    const today = toStartOfDayUTC(new Date());
    let startDate;
    let endDate;

    switch (range) {
        case 'today':
            startDate = today;
            endDate = today;
            break;
        case '7days':
            startDate = addDaysUTC(today, -6);
            endDate = today;
            break;
        case '30days':
            startDate = addDaysUTC(today, -29);
            endDate = today;
            break;
        case 'mtd':
            startDate = toStartOfDayUTC(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
            endDate = today;
            break;
        case 'custom': {
            const validated = validateCustomDates(start, end);
            startDate = validated.startDate;
            endDate = validated.endDate;
            break;
        }
        default:
            throw new Error(`Unsupported date range "${range}".`);
    }

    const endExclusive = addDaysUTC(endDate, 1);
    const dateKeys = [];
    for (let cursor = new Date(startDate); cursor <= endDate; cursor = addDaysUTC(cursor, 1)) {
        dateKeys.push(formatDateKey(cursor));
    }

    return {
        label: RANGE_LABELS[range] || RANGE_LABELS.custom,
        range,
        startDate,
        endDate,
        endExclusive,
        dateKeys,
        daysCount: dateKeys.length
    };
};

const serializeDateRange = (range) => ({
    label: range.label,
    start: range.startDate.toISOString(),
    end: range.endDate.toISOString()
});

const fetchRoomTypes = async (models, propertyId) => {
    const roomTypes = await models.RoomType.find({ property: propertyId }).lean();
    return roomTypes.map((roomType) => ({
        id: roomType._id.toString(),
        name: roomType.name,
        totalRooms: toNumber(roomType.totalInventory, 0)
    }));
};

const fetchReservationsForRange = async (models, range, propertyId) => {
    const reservations = await models.Reservations.find({
        property: propertyId,
        checkInDate: { $lt: range.endExclusive },
        checkOutDate: { $gt: range.startDate }
    }).lean();

    return reservations.filter((reservation) => {
        if (!reservation.status) {
            return true;
        }
        const status = reservation.status.toString().toLowerCase();
        return !EXCLUDED_RESERVATION_STATUSES.has(status);
    });
};

const computeOccupancy = (range, reservations, roomTypes) => {
    const totalRooms = roomTypes.reduce((sum, roomType) => sum + toNumber(roomType.totalRooms, 0), 0);
    const dailyMap = {};
    range.dateKeys.forEach((dateKey) => {
        dailyMap[dateKey] = {
            date: dateKey,
            roomsSold: 0,
            totalRooms,
            occupancyPercent: 0
        };
    });

    const roomTypeMap = {};
    roomTypes.forEach((roomType) => {
        roomTypeMap[roomType.id] = {
            roomTypeId: roomType.id,
            roomType: roomType.name,
            totalRooms: toNumber(roomType.totalRooms, 0),
            roomNightsSold: 0
        };
    });

    let totalRoomsSold = 0;

    reservations.forEach((reservation) => {
        if (!reservation.checkInDate || !reservation.checkOutDate) {
            return;
        }
        const reservationCheckIn = toStartOfDayUTC(reservation.checkInDate);
        const reservationCheckOut = toStartOfDayUTC(reservation.checkOutDate);
        const overlapStart = reservationCheckIn > range.startDate ? reservationCheckIn : range.startDate;
        const overlapEnd = reservationCheckOut < range.endExclusive ? reservationCheckOut : range.endExclusive;

        if (overlapStart >= overlapEnd) {
            return;
        }

        const roomsBooked = getRoomCount(reservation);
        const roomTypeId = reservation.roomType ? reservation.roomType.toString() : null;

        for (let cursor = new Date(overlapStart); cursor < overlapEnd; cursor = addDaysUTC(cursor, 1)) {
            const dateKey = formatDateKey(cursor);
            const dailyEntry = dailyMap[dateKey];
            if (!dailyEntry) {
                continue;
            }
            dailyEntry.roomsSold += roomsBooked;
            totalRoomsSold += roomsBooked;
            if (roomTypeId && roomTypeMap[roomTypeId]) {
                roomTypeMap[roomTypeId].roomNightsSold += roomsBooked;
            }
        }
    });

    const dailyOccupancy = range.dateKeys.map((dateKey) => {
        const entry = dailyMap[dateKey];
        entry.occupancyPercent = entry.totalRooms > 0 ? (entry.roomsSold / entry.totalRooms) * 100 : 0;
        return entry;
    });

    const roomTypeOccupancy = Object.values(roomTypeMap).map((entry) => ({
        roomTypeId: entry.roomTypeId,
        roomType: entry.roomType,
        totalRooms: entry.totalRooms,
        averageOccupancy: entry.totalRooms > 0 && range.daysCount > 0
            ? (entry.roomNightsSold / (entry.totalRooms * range.daysCount)) * 100
            : 0
    }));

    const arrivals = reservations.filter((reservation) => {
        if (!reservation.checkInDate) {
            return false;
        }
        const checkIn = toStartOfDayUTC(reservation.checkInDate);
        return checkIn >= range.startDate && checkIn < range.endExclusive;
    }).length;

    const departures = reservations.filter((reservation) => {
        if (!reservation.checkOutDate) {
            return false;
        }
        const checkOut = toStartOfDayUTC(reservation.checkOutDate);
        return checkOut >= range.startDate && checkOut < range.endExclusive;
    }).length;

    const totalRoomNightsAvailable = totalRooms * range.daysCount;
    const averageOccupancyPercent = totalRoomNightsAvailable > 0
        ? (totalRoomsSold / totalRoomNightsAvailable) * 100
        : 0;

    return {
        dailyOccupancy,
        roomTypeOccupancy,
            roomTypeDistribution: roomTypes.map(({ name, totalRooms }) => ({
            roomType: name,
                totalRooms: toNumber(totalRooms, 0)
        })),
        totalRooms,
        totalRoomsSold,
        totalRoomNightsAvailable,
        averageOccupancyPercent,
        arrivals,
        departures
    };
};

const computeRevenue = async (models, range, dailyOccupancyMap, propertyId) => {
    const initialiseDaily = () => ({
        totalRevenue: 0,
        roomRevenue: 0,
        fBRevenue: 0,
        spaRevenue: 0,
        laundryRevenue: 0,
        otherRevenue: 0,
        adr: 0,
        revPar: 0
    });

    const dailyRevenueMap = {};
    range.dateKeys.forEach((dateKey) => {
        dailyRevenueMap[dateKey] = { date: dateKey, ...initialiseDaily() };
    });

    const departmentTotals = {};

    const assignRevenue = (item, context) => {
        const quantity = Math.max(1, toNumber(item.quantity, 1));
        const amount = toNumber(item.amount);
        const unitPrice = toNumber(item.unitPrice);
        const tax = toNumber(item.tax);
        const discount = toNumber(item.discount);

        let baseAmount = 0;

        if (item.total !== undefined && item.total !== null) {
            baseAmount = toNumber(item.total);
        } else if (amount !== 0 && unitPrice !== 0) {
            // When both amount and unit price exist, prefer amount as the already computed total
            baseAmount = amount;
        } else if (amount !== 0) {
            baseAmount = quantity > 1 && unitPrice === 0 ? amount * quantity : amount;
        } else if (unitPrice !== 0) {
            baseAmount = unitPrice * quantity;
        }

        const total = baseAmount + tax - discount;

        if (total === 0) {
            return;
        }

        const department = normalizeDepartment(item.department);
        const dailyEntry = dailyRevenueMap[context.dateKey];

        if (!dailyEntry) {
            return;
        }

        dailyEntry.totalRevenue += total;

        switch (department) {
            case 'Room':
                dailyEntry.roomRevenue += total;
                break;
            case 'F&B':
                dailyEntry.fBRevenue += total;
                break;
            case 'Spa':
                dailyEntry.spaRevenue += total;
                break;
            case 'Laundry':
                dailyEntry.laundryRevenue += total;
                break;
            default:
                dailyEntry.otherRevenue += total;
                break;
        }

        departmentTotals[department] = (departmentTotals[department] || 0) + total;
    };

    const processFinancialDocuments = (documents) => {
        documents.forEach((document) => {
            if (!Array.isArray(document.items)) {
                return;
            }
            document.items.forEach((item) => {
                const referenceDate = item.date ? toStartOfDayUTC(item.date) : (document.checkIn ? toStartOfDayUTC(document.checkIn) : null);
                if (!referenceDate) {
                    return;
                }

                if (referenceDate < range.startDate || referenceDate >= range.endExclusive) {
                    return;
                }

                assignRevenue(item, { dateKey: formatDateKey(referenceDate) });
            });
        });
    };

    const [folios, bills] = await Promise.all([
        models.GuestFolio.find({
            property: propertyId,
            checkIn: { $lt: range.endExclusive },
            checkOut: { $gt: range.startDate }
        }).lean(),
        models.Bill.find({
            property: propertyId,
            checkIn: { $lt: range.endExclusive },
            checkOut: { $gt: range.startDate }
        }).lean()
    ]);

    processFinancialDocuments(folios);
    processFinancialDocuments(bills);

    const dailyRevenue = range.dateKeys.map((dateKey) => {
        const dailyEntry = dailyRevenueMap[dateKey];
        const occupancyEntry = dailyOccupancyMap[dateKey];
        const roomsSold = occupancyEntry ? toNumber(occupancyEntry.roomsSold) : 0;
        const totalRooms = occupancyEntry ? toNumber(occupancyEntry.totalRooms) : 0;

        dailyEntry.adr = roomsSold > 0 ? dailyEntry.roomRevenue / roomsSold : 0;
        dailyEntry.revPar = totalRooms > 0 ? dailyEntry.roomRevenue / totalRooms : 0;

        return dailyEntry;
    });

    const totals = dailyRevenue.reduce((accumulator, dailyEntry) => {
        accumulator.totalRevenue += toNumber(dailyEntry.totalRevenue);
        accumulator.roomRevenue += toNumber(dailyEntry.roomRevenue);
        accumulator.fBRevenue += toNumber(dailyEntry.fBRevenue);
        accumulator.spaRevenue += toNumber(dailyEntry.spaRevenue);
        accumulator.laundryRevenue += toNumber(dailyEntry.laundryRevenue);
        accumulator.otherRevenue += toNumber(dailyEntry.otherRevenue);
        return accumulator;
    }, {
        totalRevenue: 0,
        roomRevenue: 0,
        fBRevenue: 0,
        spaRevenue: 0,
        laundryRevenue: 0,
        otherRevenue: 0
    });

    const totalDepartmentRevenue = Object.values(departmentTotals).reduce((sum, value) => sum + value, 0);

    const revenueSources = Object.entries(departmentTotals).map(([department, amount]) => ({
        source: department,
        amount,
        percentage: totalDepartmentRevenue > 0 ? (amount / totalDepartmentRevenue) * 100 : 0
    })).sort((a, b) => b.amount - a.amount);

    return {
        dailyRevenue,
        totals,
        revenueSources
    };
};

const computeChannelPerformance = (range, reservations) => {
    const channelMap = new Map();
    let totalBookings = 0;
    let totalRevenue = 0;

    reservations.forEach((reservation) => {
        if (!reservation.checkInDate) {
            return;
        }

        const checkIn = toStartOfDayUTC(reservation.checkInDate);
        if (checkIn < range.startDate || checkIn >= range.endExclusive) {
            return;
        }

        const channelNameRaw = reservation.Source || reservation.source || 'Direct';
        const channelName = channelNameRaw ? channelNameRaw.toString().trim() || 'Direct' : 'Direct';
        const revenue = toNumber(reservation.totalAmount, 0);
        const roomsBooked = getRoomCount(reservation);
        const checkOut = reservation.checkOutDate ? toStartOfDayUTC(reservation.checkOutDate) : addDaysUTC(checkIn, 1);
        const overlapEnd = checkOut < range.endExclusive ? checkOut : range.endExclusive;
        const nights = Math.max(0, Math.round((overlapEnd - checkIn) / (1000 * 60 * 60 * 24)));

        const existing = channelMap.get(channelName) || {
            channelName,
            bookingCount: 0,
            totalRevenue: 0,
            roomsSold: 0
        };

        existing.bookingCount += 1;
        existing.totalRevenue += revenue;
        existing.roomsSold += roomsBooked * Math.max(nights, 1);

        channelMap.set(channelName, existing);
        totalBookings += 1;
        totalRevenue += revenue;
    });

    const channels = Array.from(channelMap.values()).map((entry) => ({
        channelName: entry.channelName,
        bookingCount: entry.bookingCount,
        totalRevenue: entry.totalRevenue,
        avgRevenuePerBooking: entry.bookingCount > 0 ? entry.totalRevenue / entry.bookingCount : 0,
        roomsSold: entry.roomsSold,
        percentage: totalRevenue > 0 ? (entry.totalRevenue / totalRevenue) * 100 : 0
    })).sort((a, b) => b.totalRevenue - a.totalRevenue);

    return {
        summary: {
            totalBookings,
            totalRevenue,
            channelsCount: channels.length,
            topChannel: channels[0] || null
        },
        channels
    };
};

const upsertSnapshot = async (models, type, range, filters, summary, propertyId) => {
    try {
        await models.ReportSnapshot.findOneAndUpdate(
            {
                type,
                property: propertyId,
                'dateRange.start': range.startDate,
                'dateRange.end': range.endDate
            },
                {
                type,
                property: propertyId,
                dateRange: {
                    label: range.label,
                    start: range.startDate,
                    end: range.endDate
                },
                filters,
                summary,
                generatedAt: new Date()
            },
            {
                new: true,
                upsert: true,
                setDefaultsOnInsert: true
            }
        );
    } catch (error) {
        // Do not block the main flow if caching fails
        console.error('Error storing report snapshot:', error.message);
    }
};

const getDashboardReport = async (models, query, propertyId) => {
    const range = resolveDateRange(query.range, query.start, query.end);

    const [roomTypes, reservations] = await Promise.all([
        fetchRoomTypes(models, propertyId),
        fetchReservationsForRange(models, range, propertyId)
    ]);

    const occupancy = computeOccupancy(range, reservations, roomTypes);
    const dailyOccupancyMap = occupancy.dailyOccupancy.reduce((accumulator, entry) => {
        accumulator[entry.date] = entry;
        return accumulator;
    }, {});

    const revenue = await computeRevenue(models, range, dailyOccupancyMap, propertyId);

    const revenueTrend = revenue.dailyRevenue.map((dailyEntry) => ({
        date: dailyEntry.date,
        revenue: dailyEntry.totalRevenue,
        occupancy: dailyOccupancyMap[dailyEntry.date]?.occupancyPercent || 0
    }));

    const occupancyTrend = occupancy.dailyOccupancy.map((dailyEntry) => ({
        date: dailyEntry.date,
        occupancy: dailyEntry.occupancyPercent
    }));

    const kpis = {
        occupancyPercent: occupancy.averageOccupancyPercent,
        adr: occupancy.totalRoomsSold > 0 ? revenue.totals.roomRevenue / occupancy.totalRoomsSold : 0,
        revPar: occupancy.totalRoomNightsAvailable > 0 ? revenue.totals.roomRevenue / occupancy.totalRoomNightsAvailable : 0,
        totalRevenue: revenue.totals.totalRevenue,
        arrivals: occupancy.arrivals,
        departures: occupancy.departures
    };

    await upsertSnapshot(models, 'dashboard', range, query, kpis, propertyId);

    return {
        dateRange: serializeDateRange(range),
        kpis,
        revenueTrend,
        occupancyTrend
    };
};

const getOccupancyReport = async (models, query, propertyId) => {
    const range = resolveDateRange(query.range, query.start, query.end);

    const [roomTypes, reservations] = await Promise.all([
        fetchRoomTypes(models, propertyId),
        fetchReservationsForRange(models, range, propertyId)
    ]);

    const occupancy = computeOccupancy(range, reservations, roomTypes);

    const summary = {
        averageOccupancyPercent: occupancy.averageOccupancyPercent,
        roomsSold: occupancy.totalRoomsSold,
        totalRoomNightsAvailable: occupancy.totalRoomNightsAvailable
    };

    await upsertSnapshot(models, 'occupancy', range, query, summary, propertyId);

    return {
        dateRange: serializeDateRange(range),
        summary,
        dailyOccupancy: occupancy.dailyOccupancy,
        roomTypeOccupancy: occupancy.roomTypeOccupancy,
        roomTypeDistribution: occupancy.roomTypeDistribution
    };
};

const getRevenueReport = async (models, query, propertyId) => {
    const range = resolveDateRange(query.range, query.start, query.end);

    const [roomTypes, reservations] = await Promise.all([
        fetchRoomTypes(models, propertyId),
        fetchReservationsForRange(models, range, propertyId)
    ]);

    const occupancy = computeOccupancy(range, reservations, roomTypes);
    const dailyOccupancyMap = occupancy.dailyOccupancy.reduce((accumulator, entry) => {
        accumulator[entry.date] = entry;
        return accumulator;
    }, {});

    const revenue = await computeRevenue(models, range, dailyOccupancyMap, propertyId);

    const summary = {
        totalRevenue: revenue.totals.totalRevenue,
        roomRevenue: revenue.totals.roomRevenue,
        fBRevenue: revenue.totals.fBRevenue,
        spaRevenue: revenue.totals.spaRevenue,
        laundryRevenue: revenue.totals.laundryRevenue,
        otherRevenue: revenue.totals.otherRevenue,
        adr: occupancy.totalRoomsSold > 0 ? revenue.totals.roomRevenue / occupancy.totalRoomsSold : 0,
        revPar: occupancy.totalRoomNightsAvailable > 0 ? revenue.totals.roomRevenue / occupancy.totalRoomNightsAvailable : 0
    };

    await upsertSnapshot(models, 'revenue', range, query, summary, propertyId);

    return {
        dateRange: serializeDateRange(range),
        summary,
        dailyRevenue: revenue.dailyRevenue,
        revenueSources: revenue.revenueSources
    };
};

const getChannelPerformanceReport = async (models, query, propertyId) => {
    const range = resolveDateRange(query.range, query.start, query.end);

    const reservations = await fetchReservationsForRange(models, range, propertyId);
    const channelPerformance = computeChannelPerformance(range, reservations);

    await upsertSnapshot(models, 'channel-performance', range, query, channelPerformance.summary, propertyId);

    return {
        dateRange: serializeDateRange(range),
        summary: channelPerformance.summary,
        channels: channelPerformance.channels
    };
};

module.exports = {
    resolveDateRange,
    getDashboardReport,
    getOccupancyReport,
    getRevenueReport,
    getChannelPerformanceReport
};

