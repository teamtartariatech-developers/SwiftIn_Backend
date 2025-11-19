const express = require('express');
const router = express.Router();
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, isValidObjectId } = require('../../utils/validation');

router.use(express.json());
router.use(authenticate);
router.use(requireModuleAccess('distribution'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

router.post('/createPromotion', async (req, res) => {
    try {
        // Validate and set defaults
        const promotionSchema = {
            name: { type: 'string', required: true },
            couponCode: { type: 'string', required: true },
            lastdate: { type: 'string', required: true, isDate: true },
            discount: { type: 'number', required: true, min: 0 },
            discountType: { type: 'string', required: true, enum: ['percentage', 'fixed'] },
            isActive: { type: 'boolean', default: true }
        };

        const validation = validateAndSetDefaults(req.body, promotionSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const Promotion = getModel(req, 'Promotion');
        const promotion = new Promotion({
            ...validation.validated,
            property: getPropertyId(req),
        });
        await promotion.save();
        res.status(201).json(promotion);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ message: 'A promotion with this coupon code already exists.' });
        }
        res.status(500).json({ message: error.message });
    }
});

router.get('/getPromotions', async (req, res) => {
    try {
        const Promotion = getModel(req, 'Promotion');
        const promotions = await Promotion.find({ property: getPropertyId(req) });
        res.status(200).json(promotions);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.put('/updatePromotion/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid promotion ID format' });
        }

        // Validate update fields (all optional)
        const updateSchema = {
            name: { type: 'string' },
            couponCode: { type: 'string' },
            lastdate: { type: 'string', isDate: true },
            discount: { type: 'number', min: 0 },
            discountType: { type: 'string', enum: ['percentage', 'fixed'] },
            isActive: { type: 'boolean' }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const Promotion = getModel(req, 'Promotion');
        const promotion = await Promotion.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            validation.validated,
            { new: true }
        );

        if (!promotion) {
            return res.status(404).json({ message: 'Promotion not found.' });
        }

        res.status(200).json(promotion);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.delete('/deletePromotion/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid promotion ID format' });
        }
        
        const Promotion = getModel(req, 'Promotion');
        const result = await Promotion.findOneAndDelete({ _id: id, property: getPropertyId(req) });

        if (!result) {
            return res.status(404).json({ message: 'Promotion not found.' });
        }

        res.status(200).json({ message: 'Promotion deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;