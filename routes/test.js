const express = require('express');
const routes = new express.Router();
const { authenticate } = require('../middleware/auth');

routes.use(express.json());
routes.use(authenticate);

const getModel = (req, name) => req.tenant.models[name];

routes.get('/', (req, res) => {
    res.send('Test route is working!');
});

routes.get('/reservations', async (req, res) => { 
    const Reservations = getModel(req, 'Reservations');
    const data = await Reservations.find({ property: req.tenant.property._id });
    res.json(data);
})

routes.post('/reservations', async (req, res) => {
    try {
        const Reservations = getModel(req, 'Reservations');
        const newReservation = new Reservations({
            ...req.body,
            property: req.tenant.property._id,
        });
        await newReservation.save();
        res.status(201).send(newReservation);
    } catch (error) {
        res.status(400).send(error.message);
    }
});

module.exports = routes;