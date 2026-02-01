// middleware/auth0.js
const { auth } = require('express-oauth2-jwt-bearer');

const jwtCheck = auth({
  audience: process.env.AUTH0_AUDIENCE || 'https://api.time-4-action.com',
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL || 'https://time-4-action.eu.auth0.com/',
  tokenSigningAlg: 'RS256',
});

module.exports = jwtCheck;
