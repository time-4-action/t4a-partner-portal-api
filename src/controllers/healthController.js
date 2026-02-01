const healthService = require('../services/health.service');
const packageJson = require('../../package.json');

exports.getHealth = async (req, res) => {
    try {
        const dependencies = await healthService.checkDependencies();
        const isHealthy = Object.values(dependencies).every(status => status === 'ok');

        const healthInfo = {
            status: isHealthy ? 'ok' : 'error',
            version: packageJson.version,
            appName: process.env.APP_NAME || 'Automation API',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            dependencies: dependencies
        };

        res.status(isHealthy ? 200 : 503).json(healthInfo);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'An unexpected error occurred during health check.',
            error: error.message
        });
    }
};
