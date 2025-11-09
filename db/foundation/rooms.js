const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const rooms = new mongoose.Schema({
    roomNumber: String,
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType',
        required: true
    },
    status: String
});

rooms.plugin(propertyScoped);

const RoomsModel =
    mongoose.models.Rooms || mongoose.model('Rooms', rooms);

module.exports = RoomsModel;
module.exports.schema = rooms;