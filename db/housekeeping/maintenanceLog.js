const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const STATUS_OPTIONS = ['open', 'in-progress', 'resolved'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high'];

const maintenanceLogSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      required: true,
    },
    location: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    priority: {
      type: String,
      enum: PRIORITY_OPTIONS,
      default: 'medium',
    },
    status: {
      type: String,
      enum: STATUS_OPTIONS,
      default: 'open',
      index: true,
    },
    reportedBy: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
      email: String,
      role: String,
    },
    assignedTo: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      name: String,
    },
    notes: {
      type: String,
      trim: true,
    },
    resolvedAt: Date,
    history: [
      {
        status: {
          type: String,
          enum: STATUS_OPTIONS,
        },
        note: String,
        updatedBy: {
          id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
          },
          name: String,
          role: String,
        },
        updatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

maintenanceLogSchema.plugin(propertyScoped);
maintenanceLogSchema.index({ property: 1, ticketNumber: 1 }, { unique: true });

maintenanceLogSchema.pre('validate', function assignTicketNumber(next) {
  if (!this.ticketNumber) {
    const timestamp = Date.now().toString(36).toUpperCase();
    this.ticketNumber = `MT-${timestamp}`;
  }
  next();
});

const MaintenanceLog =
  mongoose.models.MaintenanceLog || mongoose.model('MaintenanceLog', maintenanceLogSchema);

module.exports = MaintenanceLog;
module.exports.schema = maintenanceLogSchema;

