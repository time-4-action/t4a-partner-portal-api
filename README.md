# Patrik Products Automation

This project is a Node.js application designed to automate the management and enrichment of product data from various sources. It synchronizes product information from a PNV (Partner.net Vision) system, enriches it with stock and pricing data from the Metakocka API, uses Google's Generative AI to automatically categorize products, and exposes the consolidated data through a secure RESTful API.

## Core Features

-   **Automated Product Synchronization**: Regularly fetches the latest product data from a PNV system via a scheduled job.
-   **Data Enrichment**: Enriches product data with real-time stock levels and pricing information from the Metakocka ERP system.
-   **AI-Powered Categorization**: Utilizes Google Gemini to intelligently assign categories to products, which can be configured on a per-export basis.
-   **Secure REST API**: Provides a set of secure endpoints (protected by Auth0) to access product, category, and export configuration data.
-   **Performance Monitoring**: Includes built-in analytics to monitor the performance of API calls and critical background jobs, storing metrics in MongoDB.
-   **Configurable Data Mapping**: Allows for flexible mapping of incoming CSV data from PNV to the internal JSON data structure.

## Technology Stack

-   **Backend**: Node.js, Express.js
-   **Database**: MongoDB
-   **Authentication**: Auth0 (JWT Bearer Tokens)
-   **AI**: Google Generative AI (Gemini 2.5 Flash)
-   **Job Scheduling**: `node-cron`
-   **External APIs**: PNV (Partner.net Vision), Metakocka

## Getting Started

### Prerequisites

-   Node.js (v18 or later)
-   npm
-   Access to a MongoDB database
-   Credentials for PNV, Metakocka, Google AI, and Auth0.

### Installation

1.  Clone the repository:
    ```bash
    git clone <repository-url>
    cd patrik-products-automation
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

### Environment Variables

Create a `.env` file in the root of the project and add the following variables. These are essential for the application to run correctly.

```env
# Application
APP_NAME=PatrikProductsAutomation
NODE_ENV=development # or production

# MongoDB
MONGO_URI=mongodb://user:password@host:port
MONGO_DB_NAME=your_db_name

# PNV (Partner.net Vision) API
PNV_BASE_URL=https://pnv.example.com
PNV_EXPORT_PRODUCTS_URL=https://pnv.example.com/path/to/export
PNV_USER=your_pnv_user
PNV_PASS=your_pnv_password
PNV_GROUP=your_pnv_group_id
PNV_USER_ID=your_pnv_user_id

# Metakocka API
METAKOCKA_KEY=your_metakocka_secret_key
METAKOCKA_ID=your_metakocka_company_id

# Google AI
GOOGLE_API_KEY=your_google_api_key

# Auth0
AUTH0_AUDIENCE=https://api.yourdomain.com
AUTH0_ISSUER_BASE_URL=https://your-tenant.eu.auth0.com/

# Job Scheduling
PRODUCTS_DOWNLOAD_SCHEDULE="0 2 * * *" # Example: Run daily at 2 AM
```

### Running the Application

```bash
npm start
```

## Project Structure

```
src/
├── app.js                    # Main Express app configuration
├── config/                   # Configuration files for external services (Metakocka, PNV)
├── controllers/              # Express controllers to handle API request logic
├── jobs/                     # Scheduled cron jobs (e.g., product sync)
├── middleware/               # Custom Express middleware (auth, logging, analytics)
├── models/                   # Data models (currently an example, as MongoDB is schemaless)
├── routes/                   # API route definitions
└── services/                 # Business logic, DB interactions, and external API clients
    ├── ai/                   # Services related to Google AI
    ├── db/                   # MongoDB connection service
    ├── metakocka/            # Services for interacting with the Metakocka API
    └── pnv/                  # Services for the PNV product synchronization process
```

## API Endpoints

All API endpoints are prefixed with `/api/export`. Most endpoints are secured with Auth0 JWT authentication; public endpoints like the Health Check are explicitly noted.

### Health Check

-   `GET /api/export/health`
    -   **Description**: Provides a detailed health status of the service, including dependencies like the database connection, memory usage, and uptime. This endpoint is public and does not require authentication.
    -   **Success Response (`200 OK`)**:
        ```json
        {
            "status": "ok",
            "version": "1.0.0",
            "appName": "PatrikProductsAutomation",
            "timestamp": "2026-02-01T12:00:00.000Z",
            "uptime": 35.123,
            "memoryUsage": {
                "rss": 50331648,
                "heapTotal": 7692288,
                "heapUsed": 5537680,
                "external": 8272,
                "arrayBuffers": 9344
            },
            "dependencies": {
                "database": "ok"
            }
        }
        ```
    -   **Error Response (`503 Service Unavailable`)**: Indicates a problem with one of the dependencies.
        ```json
        {
            "status": "error",
            "version": "1.0.0",
            "appName": "PatrikProductsAutomation",
            "timestamp": "2026-02-01T12:01:00.000Z",
            "uptime": 95.456,
            "memoryUsage": { "...": "..." },
            "dependencies": {
                "database": "error"
            }
        }
        ```

---

### Products

-   `GET /api/export/product`
    -   **Description**: Retrieves a list of all products.
    -   **Response**: `200 OK` with an array of product objects.

-   `GET /api/export/product/:code`
    -   **Description**: Retrieves a single product by its unique `code` or `token`.
    -   **Response**: `200 OK` with the product object or `404 Not Found`.

-   `GET /api/export/product/tsv/:exportId`
    -   **Description**: Generates and returns a TSV (Tab-Separated Values) file containing product names and their AI-assigned categories for a specific export configuration.
    -   **Response**: `200 OK` with the `products.tsv` file.

### Categories

-   `GET /api/export/categories`
    -   **Description**: Retrieves all available categories from the database.
    -   **Response**: `200 OK` with an array of category objects.

-   `GET /api/export/categories/by-export/:exportId`
    -   **Description**: Retrieves all categories associated with a specific export ID.
    -   **Response**: `200 OK` with an array of category objects.

### Exports

-   `GET /api/export/exports`
    -   **Description**: Retrieves all export configurations. Export configurations define settings, such as whether AI categorization is enabled.
    -   **Response**: `200 OK` with an array of export configuration objects.

-   `GET /api/export/exports/:id`
    -   **Description**: Retrieves a single export configuration by its `_id`.
    -   **Response**: `200 OK` with the export configuration object or `404 Not Found`.

## Scheduled Jobs

### Product Synchronization (`pnvProductSyncJob`)

This is the core background process of the application. It runs on a schedule defined by the `PRODUCTS_DOWNLOAD_SCHEDULE` environment variable.

The job performs the following sequence of tasks:

1.  **Initiates PNV Export**: Authenticates with the PNV system and triggers a product data export.
2.  **Downloads CSV**: Downloads the resulting `products.csv` file.
3.  **Processes Data**: Parses the CSV and transforms the data based on the mapping in `src/config/pnv/products.js`.
4.  **Enriches Data**: Fetches stock and price information for each product from the Metakocka API.
5.  **Syncs to DB**: Upserts the enriched product data into the MongoDB `products` collection. Products not present in the latest CSV are marked as inactive.
6.  **Runs AI Categorization**: For each export configuration with `aiCategorizationEnabled: true`, it identifies new products and uses Google Gemini to assign them a category.
7.  **Monitors Performance**: Every major step is monitored, and performance analytics are logged to the `analytics` and `aiAnalytics` collections in MongoDB.
