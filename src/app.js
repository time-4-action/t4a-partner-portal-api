const express = require('express');
const app = express();
const path = require('path');
const logger = require('./middleware/logger');
const apiAnalyticsLogger = require('./middleware/analytics');
const exportRoutes = require('./routes/export');

// Import the job initialization function to set up scheduled tasks
const initJobs = require("./jobs")

// Middleware to parse JSON bodies from incoming requests
app.use(express.json());
// Custom middleware for logging requests
app.use(logger);
// Custom middleware for API analytics logging
app.use(apiAnalyticsLogger);
// Trust the first proxy to correctly identify client IP addresses for logging and analytics
app.set('trust proxy', true);

// Serve static files from the 'public' directory, allowing client-side assets to be accessible
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
const healthRoutes = require('./routes/healthRoutes');
// Mount public health check route
app.use('/api/export/health', healthRoutes);
// Mount export-related routes under the /api/export path
app.use('/api/export', exportRoutes);

// Export the configured Express app and the job initialization function for use by the main server file
module.exports = { app, initJobs };