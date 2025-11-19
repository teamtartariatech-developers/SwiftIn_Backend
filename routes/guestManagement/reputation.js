const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, validatePagination, isValidObjectId } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('guest-management'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get all reviews with pagination and filtering
router.get('/', async (req, res) => {
    try {
        const { page, limit, search } = validatePagination(req.query);
        const { source = '', sentiment = '', rating = '' } = req.query;
        const propertyId = getPropertyId(req);
        const Review = getModel(req, 'Review');
        
        // Build filter query
        const filterQuery = { property: propertyId };
        
        if (source && source !== 'all') {
            filterQuery.source = source;
        }
        
        if (sentiment && sentiment !== 'all') {
            filterQuery.sentiment = sentiment;
        }
        
        if (rating && rating !== 'all') {
            filterQuery.rating = parseInt(rating);
        }
        
        if (search) {
            filterQuery.$or = [
                { name: { $regex: search, $options: 'i' } },
                { review: { $regex: search, $options: 'i' } }
            ];
        }
        
        // Calculate pagination
        const skip = (page - 1) * limit;
        
        // Get total count for pagination
        const total = await Review.countDocuments(filterQuery);
        
        // Get paginated results
        const reviews = await Review.find(filterQuery)
            .skip(skip)
            .limit(limit)
            .sort({ date: -1 }); // Sort by newest first
        
        // Calculate statistics
        const stats = await Review.aggregate([
            { $match: filterQuery },
            {
                $group: {
                    _id: null,
                    totalReviews: { $sum: 1 },
                    averageRating: { $avg: '$rating' },
                    positiveCount: {
                        $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] }
                    },
                    neutralCount: {
                        $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] }
                    },
                    negativeCount: {
                        $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] }
                    }
                }
            }
        ]);
        
        res.status(200).json({
            reviews,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalItems: total,
                itemsPerPage: limit
            },
            statistics: stats[0] || {
                totalReviews: 0,
                averageRating: 0,
                positiveCount: 0,
                neutralCount: 0,
                negativeCount: 0
            }
        });
    } catch (error) {
        console.error('Error fetching reviews:', error);
        res.status(500).json({ message: "Server error fetching reviews." });
    }
});

// Get all reviews (for dropdowns, etc.)
router.get('/all', async (req, res) => {
    try {
        const Review = getModel(req, 'Review');
        const reviews = await Review.find({ property: getPropertyId(req) }).sort({ date: -1 });
        res.status(200).json(reviews);
    } catch (error) {
        console.error('Error fetching all reviews:', error);
        res.status(500).json({ message: "Server error fetching all reviews." });
    }
});

// Get review by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid review ID format' });
        }
        
        const Review = getModel(req, 'Review');
        const review = await Review.findOne({ _id: id, property: getPropertyId(req) });
        if (!review) {
            return res.status(404).json({ message: "Review not found." });
        }
        res.status(200).json(review);
    } catch (error) {
        console.error('Error fetching review:', error);
        res.status(500).json({ message: "Server error fetching review." });
    }
});

// Create new review
router.post('/', async (req, res) => {
    
    try {
        // Validate and set defaults
        const reviewSchema = {
            name: { type: 'string', required: true },
            review: { type: 'string', required: true },
            rating: { type: 'number', required: true, min: 1, max: 5, custom: (val) => Number.isInteger(val) || 'Rating must be an integer' },
            source: { type: 'string', required: true, enum: ['Google', 'MakeMyTrip', 'Booking.com', 'Direct', 'TripAdvisor', 'Expedia'] }
        };

        const validation = validateAndSetDefaults(req.body, reviewSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { name, review, rating, source } = validation.validated;
        
        // Get sentiment from AI API
        const aiApiBaseUrl = process.env.AI_API_BASEURL;
        if (!aiApiBaseUrl) {
            return res.status(500).json({ 
                message: "AI_API_BASEURL environment variable is not configured." 
            });
        }
        
        let sentiment;
        try {
            const aiResponse = await axios.post(
                `${aiApiBaseUrl}/inAppAI/sentimentAnalysis`,
                { text: review },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            // Extract sentiment from response
            sentiment = aiResponse.data.sentiment?.toLowerCase();
            
            
            // Validate sentiment value
            const validSentiments = ['positive', 'neutral', 'negative'];
            if (!sentiment || !validSentiments.includes(sentiment)) {
                console.error('Invalid sentiment received from AI API:', sentiment);
                sentiment = 'neutral';
            }
            else{
                res.status(200).json({
                    message: "Sentiment analyzed successfully.",
                    sentiment: sentiment
                });
            }
        } catch (aiError) {
            console.error('Error calling AI API for sentiment analysis:', aiError);
            return res.status(502).json({ 
                message: "Failed to analyze sentiment. AI service unavailable." 
            });
        }
        
        const Review = getModel(req, 'Review');
        const newReview = new Review({
            name,
            review,
            rating,
            source,
            sentiment,
            property: getPropertyId(req)
        });
        
        await newReview.save();
        res.status(201).json(newReview);
    } catch (error) {
        console.error('Error creating review:', error);
        res.status(500).json({ message: "Server error creating review." });
    }
});

// Update review
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid review ID format' });
        }

        // Validate update fields
        const updateSchema = {
            name: { type: 'string' },
            review: { type: 'string' },
            rating: { type: 'number', min: 1, max: 5, custom: (val) => !val || Number.isInteger(val) || 'Rating must be an integer' },
            source: { type: 'string', enum: ['Google', 'MakeMyTrip', 'Booking.com', 'Direct', 'TripAdvisor', 'Expedia'] },
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            verified: { type: 'boolean' }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const Review = getModel(req, 'Review');
        const updatedReview = await Review.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            validation.validated, 
            updateData, 
            { new: true, runValidators: true }
        );
        
        if (!updatedReview) {
            return res.status(404).json({ message: "Review not found." });
        }
        
        res.status(200).json(updatedReview);
    } catch (error) {
        console.error('Error updating review:', error);
        res.status(500).json({ message: "Server error updating review." });
    }
});

// Delete review
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid review ID format' });
        }
        
        const Review = getModel(req, 'Review');
        const deletedReview = await Review.findOneAndDelete({ _id: id, property: getPropertyId(req) });
        
        if (!deletedReview) {
            return res.status(404).json({ message: "Review not found." });
        }
        
        res.status(200).json({ message: "Review deleted successfully." });
    } catch (error) {
        console.error('Error deleting review:', error);
        res.status(500).json({ message: "Server error deleting review." });
    }
});

// Get review statistics
router.get('/stats/overview', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const Review = getModel(req, 'Review');
        const stats = await Review.aggregate([
            { $match: { property: propertyId } },
            {
                $group: {
                    _id: null,
                    totalReviews: { $sum: 1 },
                    averageRating: { $avg: '$rating' },
                    positiveCount: {
                        $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] }
                    },
                    neutralCount: {
                        $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] }
                    },
                    negativeCount: {
                        $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] }
                    },
                    ratingDistribution: {
                        $push: '$rating'
                    }
                }
            }
        ]);
        
        const result = stats[0] || {
            totalReviews: 0,
            averageRating: 0,
            positiveCount: 0,
            neutralCount: 0,
            negativeCount: 0,
            ratingDistribution: []
        };
        
        // Calculate rating distribution
        const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        result.ratingDistribution.forEach(rating => {
            ratingCounts[rating] = (ratingCounts[rating] || 0) + 1;
        });
        
        result.ratingDistribution = ratingCounts;
        
        res.status(200).json(result);
    } catch (error) {
        console.error('Error fetching review statistics:', error);
        res.status(500).json({ message: "Server error fetching review statistics." });
    }
});

// Get reviews summary using AI
router.post('/summarize', async (req, res) => {
    try {
        // Validate and set defaults
        const summarizeSchema = {
            reviews: { isArray: true, required: true, custom: (val) => Array.isArray(val) && val.length > 0 || 'Reviews array must not be empty' }
        };

        const validation = validateAndSetDefaults(req.body, summarizeSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { reviews } = validation.validated;
        
        // Get language from AI settings
        const propertyId = getPropertyId(req);
        const AISettings = getModel(req, 'AISettings');
        let aiSettings = await AISettings.findOne({ property: propertyId });
        
        // Default to english if no settings found
        const language = aiSettings?.language || 'english';
        
        // Get sentiment from AI API
        const aiApiBaseUrl = process.env.AI_API_BASEURL;
        if (!aiApiBaseUrl) {
            return res.status(500).json({ 
                message: "AI_API_BASEURL environment variable is not configured." 
            });
        }
        
        try {
            const aiResponse = await axios.post(
                `${aiApiBaseUrl}/inAppAI/reviewsSummarizer`,
                { 
                    reviews: reviews,
                    language: language
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            // Extract summary from response
            const summary = aiResponse.data.summary;
            
            if (!summary) {
                return res.status(502).json({ 
                    message: "AI API did not return a summary." 
                });
            }
            
            return res.status(200).json({ summary });
        } catch (aiError) {
            console.error('Error calling AI API for reviews summarizer:', aiError);
            return res.status(502).json({ 
                message: "Failed to generate summary. AI service unavailable." 
            });
        }
    } catch (error) {
        console.error('Error in reviews summarizer:', error);
        res.status(500).json({ message: "Server error generating summary." });
    }
});

// Add test reviews data
router.post('/add-test-reviews', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const Review = getModel(req, 'Review');
        const testReviews = [
            {
                name: "John Smith",
                review: "Excellent service and beautiful rooms. The staff was very helpful and the location is perfect.",
                rating: 5,
                source: "Google",
                sentiment: "positive"
            },
            {
                name: "Sarah Johnson",
                review: "Good hotel but the breakfast could be better. Room was clean and comfortable.",
                rating: 4,
                source: "Booking.com",
                sentiment: "positive"
            },
            {
                name: "Mike Wilson",
                review: "Average experience. Nothing special but nothing terrible either.",
                rating: 3,
                source: "TripAdvisor",
                sentiment: "neutral"
            },
            {
                name: "Emily Davis",
                review: "Poor service and the room was not clean. Very disappointed with my stay.",
                rating: 2,
                source: "MakeMyTrip",
                sentiment: "negative"
            },
            {
                name: "David Brown",
                review: "Amazing hotel with fantastic amenities. Will definitely come back!",
                rating: 5,
                source: "Direct",
                sentiment: "positive"
            },
            {
                name: "Lisa Anderson",
                review: "The hotel is okay but overpriced for what you get.",
                rating: 3,
                source: "Expedia",
                sentiment: "neutral"
            }
        ];
        
        // Clear existing reviews and add test data
        await Review.deleteMany({ property: propertyId });
        const createdReviews = await Review.insertMany(
            testReviews.map(review => ({ ...review, property: propertyId }))
        );
        
        res.status(200).json({ 
            message: "Test reviews added successfully", 
            reviews: createdReviews,
            count: createdReviews.length 
        });
    } catch (error) {
        console.error('Error adding test reviews:', error);
        res.status(500).json({ message: "Server error adding test reviews." });
    }
});

module.exports = router;
