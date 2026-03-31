# Custom Export API - Complete Specification

This document provides a precise, detailed specification for the custom export API endpoints used to save, retrieve, and execute export configurations.

---

## Table of Contents

1. [Overview](#overview)
2. [Data Models](#data-models)
3. [Endpoints](#endpoints)
4. [Data Flow](#data-flow)
5. [Validation Rules](#validation-rules)
6. [CSV Generation Logic](#csv-generation-logic)
7. [Error Handling](#error-handling)
8. [Implementation Examples](#implementation-examples)

---

## Overview

### Purpose

The Custom Export API allows users to:
- **Save** export configurations (preset, fields, filters, pricelist priority)
- **Retrieve** saved configurations to reload into the UI
- **Execute** saved configurations to generate CSV/JSON exports
- **Manage** (update, delete) saved configurations

### Base URL

```
{NEXT_PUBLIC_EXPORT_API_URL}/custom-export
```

Environment variable: `NEXT_PUBLIC_EXPORT_API_URL`

---

## Data Models

### 1. ExportConfiguration (Main Document)

```typescript
interface ExportConfiguration {
  // System fields (auto-generated)
  _id: ObjectId;                          // MongoDB ObjectId - auto-generated on create
  createdAt: Date;                        // ISO 8601 timestamp - set on create
  updatedAt: Date;                        // ISO 8601 timestamp - updated on every save

  // User-provided fields
  name: string;                           // Required, unique, 1-100 chars
  description: string | null;             // Optional, max 500 chars

  // Export configuration
  preset: PresetType;                     // Required, enum value
  selectedFields: string[];               // Required, min 1 field
  filters: ExportFilters;                 // Required, complete filter object
  pricelistPriority: PricelistConfig[];   // Required, ordered array

  // Metadata
  isActive: boolean;                      // Default: true, soft delete flag
  createdBy: string | null;               // Optional user identifier
}
```

### 2. PresetType (Enum)

```typescript
type PresetType = "shopify" | "simple" | "detailed" | "inventory";
```

| Preset | Description | Typical Fields |
|--------|-------------|----------------|
| `shopify` | Shopify CSV import format | handle, title, body_html, variant_sku, variant_price, image_src |
| `simple` | Basic product list | product_name, variant_name, sku, ean, price, stock |
| `detailed` | Full product data | All product fields, metadata, timestamps |
| `inventory` | Stock & pricing focus | sku, ean, stock, price, stock_value |

### 3. ExportFilters

```typescript
interface ExportFilters {
  search: string;                         // Free text search, default: ""
  stockStatus: "all" | "in_stock" | "out_of_stock";  // Default: "all"
  minPrice: string;                       // Numeric string or "", default: ""
  maxPrice: string;                       // Numeric string or "", default: ""
  category: string;                       // "all" or exact category name
  aiExportId: string;                     // "all" or MongoDB ObjectId string
  aiCategory: string;                     // "all" or MongoDB ObjectId string
  showNew: boolean;                       // Default: false
  showRecommended: boolean;               // Default: false
  publishedOnly: boolean;                 // Default: false
}
```

**Filter Logic (AND conditions):**
```
product matches IF:
  (search is empty OR name/code/sku/ean contains search) AND
  (stockStatus is "all" OR matches stock condition) AND
  (minPrice is empty OR product max price >= minPrice) AND
  (maxPrice is empty OR product min price <= maxPrice) AND
  (category is "all" OR product.categories includes category) AND
  (aiExportId is "all" OR product.ai_categories has matching exportId) AND
  (aiCategory is "all" OR product.ai_categories has matching categoryId) AND
  (showNew is false OR product.new is true) AND
  (showRecommended is false OR product.recomended is true) AND
  (publishedOnly is false OR product.published is true)
```

### 4. PricelistConfig

```typescript
interface PricelistConfig {
  name: string;           // Pricelist name, e.g., "RRP 2026"
  enabled: boolean;       // Whether to use this pricelist
  priority: number;       // 0-based index, lower = higher priority
}
```

**Price Resolution Logic:**
```javascript
function getPriceFromPriority(variant, pricelistPriority) {
  // Sort by priority (ascending)
  const sorted = pricelistPriority
    .filter(p => p.enabled)
    .sort((a, b) => a.priority - b.priority);

  // Find first pricelist that has a price for this variant
  for (const pl of sorted) {
    const found = variant.pricelist.find(p => p.name === pl.name);
    if (found && found.price !== undefined) {
      return {
        price: found.price,
        vat: found.vat || 0,
        name: found.name
      };
    }
  }

  // Fallback: first available pricelist
  return variant.pricelist[0] || { price: 0, vat: 0, name: "" };
}
```

---

## Endpoints

### 1. POST /custom-export - Create Configuration

**Purpose:** Save a new export configuration to the database.

**Request:**
```http
POST /custom-export
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "My Shopify Export",
  "description": "Weekly export for online store",
  "preset": "shopify",
  "selectedFields": [
    "handle",
    "title",
    "body_html",
    "vendor",
    "tags",
    "published",
    "variant_sku",
    "variant_title",
    "variant_price",
    "variant_inventory_qty",
    "variant_barcode",
    "image_src"
  ],
  "filters": {
    "search": "",
    "stockStatus": "in_stock",
    "minPrice": "",
    "maxPrice": "",
    "category": "all",
    "aiExportId": "all",
    "aiCategory": "all",
    "showNew": false,
    "showRecommended": false,
    "publishedOnly": true
  },
  "pricelistPriority": [
    { "name": "RRP 2026", "enabled": true, "priority": 0 },
    { "name": "RRP 2025", "enabled": true, "priority": 1 },
    { "name": "Wholesale 2026", "enabled": false, "priority": 2 }
  ]
}
```

**Server Processing Steps:**

1. **Validate request body** (see [Validation Rules](#validation-rules))
2. **Check for duplicate name:**
   ```javascript
   const existing = await ExportConfig.findOne({
     name: req.body.name,
     isActive: true
   });
   if (existing) {
     return res.status(409).json({
       success: false,
       error: "Export with this name already exists",
       code: "DUPLICATE_NAME"
     });
   }
   ```
3. **Create document:**
   ```javascript
   const config = new ExportConfig({
     name: req.body.name.trim(),
     description: req.body.description?.trim() || null,
     preset: req.body.preset,
     selectedFields: req.body.selectedFields,
     filters: {
       search: req.body.filters.search || "",
       stockStatus: req.body.filters.stockStatus || "all",
       minPrice: req.body.filters.minPrice || "",
       maxPrice: req.body.filters.maxPrice || "",
       category: req.body.filters.category || "all",
       aiExportId: req.body.filters.aiExportId || "all",
       aiCategory: req.body.filters.aiCategory || "all",
       showNew: Boolean(req.body.filters.showNew),
       showRecommended: Boolean(req.body.filters.showRecommended),
       publishedOnly: Boolean(req.body.filters.publishedOnly)
     },
     pricelistPriority: req.body.pricelistPriority.map((p, idx) => ({
       name: p.name,
       enabled: Boolean(p.enabled),
       priority: p.priority ?? idx
     })),
     isActive: true,
     createdAt: new Date(),
     updatedAt: new Date()
   });
   ```
4. **Save to database:**
   ```javascript
   await config.save();
   ```
5. **Return created document:**

**Success Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "_id": "65c4a1b2c3d4e5f6a7b8c9d0",
    "name": "My Shopify Export",
    "description": "Weekly export for online store",
    "preset": "shopify",
    "selectedFields": ["handle", "title", "..."],
    "filters": {
      "search": "",
      "stockStatus": "in_stock",
      "minPrice": "",
      "maxPrice": "",
      "category": "all",
      "aiExportId": "all",
      "aiCategory": "all",
      "showNew": false,
      "showRecommended": false,
      "publishedOnly": true
    },
    "pricelistPriority": [
      { "name": "RRP 2026", "enabled": true, "priority": 0 },
      { "name": "RRP 2025", "enabled": true, "priority": 1 },
      { "name": "Wholesale 2026", "enabled": false, "priority": 2 }
    ],
    "isActive": true,
    "createdAt": "2026-02-06T10:30:00.000Z",
    "updatedAt": "2026-02-06T10:30:00.000Z"
  }
}
```

---

### 2. GET /custom-export - List All Configurations

**Purpose:** Retrieve all saved export configurations for display in the UI.

**Request:**
```http
GET /custom-export
GET /custom-export?preset=shopify
GET /custom-export?active=true
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `active` | boolean | `true` | Filter by isActive status |
| `preset` | string | - | Filter by preset type |
| `sort` | string | `-createdAt` | Sort field (prefix `-` for descending) |
| `limit` | number | `50` | Max results to return |

**Server Processing:**
```javascript
const query = { isActive: req.query.active !== 'false' };

if (req.query.preset) {
  query.preset = req.query.preset;
}

const configs = await ExportConfig
  .find(query)
  .select('_id name description preset selectedFields createdAt updatedAt')
  .sort(req.query.sort || '-createdAt')
  .limit(parseInt(req.query.limit) || 50);
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "count": 3,
  "data": [
    {
      "_id": "65c4a1b2c3d4e5f6a7b8c9d0",
      "name": "My Shopify Export",
      "description": "Weekly export for online store",
      "preset": "shopify",
      "selectedFields": ["handle", "title", "body_html", "..."],
      "createdAt": "2026-02-06T10:30:00.000Z",
      "updatedAt": "2026-02-06T10:30:00.000Z"
    },
    {
      "_id": "65c4a1b2c3d4e5f6a7b8c9d1",
      "name": "Inventory Check",
      "description": null,
      "preset": "inventory",
      "selectedFields": ["sku", "ean", "stock", "price"],
      "createdAt": "2026-02-05T14:20:00.000Z",
      "updatedAt": "2026-02-05T14:20:00.000Z"
    }
  ]
}
```

**Frontend Usage:**
```javascript
// In ExportPage.js - loadSavedExports()
const loadSavedExports = async () => {
  setIsLoadingExports(true);
  try {
    const response = await fetch(`${apiUrl}/custom-export`);
    if (response.ok) {
      const result = await response.json();
      setSavedExports(result.data || []);
    }
  } catch (error) {
    console.error("Failed to load exports:", error);
  } finally {
    setIsLoadingExports(false);
  }
};
```

---

### 3. GET /custom-export/:id - Get Single Configuration

**Purpose:** Retrieve complete configuration data to load into the UI.

**Request:**
```http
GET /custom-export/65c4a1b2c3d4e5f6a7b8c9d0
```

**Server Processing:**
```javascript
const config = await ExportConfig.findOne({
  _id: req.params.id,
  isActive: true
});

if (!config) {
  return res.status(404).json({
    success: false,
    error: "Export configuration not found",
    code: "NOT_FOUND"
  });
}
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "_id": "65c4a1b2c3d4e5f6a7b8c9d0",
    "name": "My Shopify Export",
    "description": "Weekly export for online store",
    "preset": "shopify",
    "selectedFields": ["handle", "title", "body_html", "vendor", "tags", "published", "variant_sku", "variant_title", "variant_price", "variant_inventory_qty", "variant_barcode", "image_src"],
    "filters": {
      "search": "",
      "stockStatus": "in_stock",
      "minPrice": "",
      "maxPrice": "",
      "category": "all",
      "aiExportId": "all",
      "aiCategory": "all",
      "showNew": false,
      "showRecommended": false,
      "publishedOnly": true
    },
    "pricelistPriority": [
      { "name": "RRP 2026", "enabled": true, "priority": 0 },
      { "name": "RRP 2025", "enabled": true, "priority": 1 },
      { "name": "Wholesale 2026", "enabled": false, "priority": 2 }
    ],
    "isActive": true,
    "createdAt": "2026-02-06T10:30:00.000Z",
    "updatedAt": "2026-02-06T10:30:00.000Z"
  }
}
```

**Frontend Usage:**
```javascript
// In ExportPage.js - loadExportConfig()
const loadExportConfig = (config) => {
  // Set preset first (this determines available fields)
  setSelectedPreset(config.preset);

  // Set selected fields
  setSelectedFields(config.selectedFields);

  // Set filters (spread to ensure all keys exist)
  setFilters({
    search: "",
    stockStatus: "all",
    minPrice: "",
    maxPrice: "",
    category: "all",
    aiExportId: "all",
    aiCategory: "all",
    showNew: false,
    showRecommended: false,
    publishedOnly: false,
    ...config.filters
  });

  // Set pricelist priority if available
  if (config.pricelistPriority?.length > 0) {
    setPricelistPriority(config.pricelistPriority);
  }

  // Switch to configure tab
  setActiveTab("configure");

  setExportStatus("Configuration loaded!");
  setTimeout(() => setExportStatus(""), 3000);
};
```

---

### 4. PUT /custom-export/:id - Update Configuration

**Purpose:** Update an existing export configuration.

**Request:**
```http
PUT /custom-export/65c4a1b2c3d4e5f6a7b8c9d0
Content-Type: application/json
```

**Request Body (partial update supported):**
```json
{
  "name": "Updated Export Name",
  "description": "New description",
  "filters": {
    "stockStatus": "all",
    "publishedOnly": false
  }
}
```

**Server Processing:**
```javascript
// Find existing config
const existing = await ExportConfig.findById(req.params.id);
if (!existing) {
  return res.status(404).json({
    success: false,
    error: "Export configuration not found",
    code: "NOT_FOUND"
  });
}

// Check for name conflict if name is being changed
if (req.body.name && req.body.name !== existing.name) {
  const nameConflict = await ExportConfig.findOne({
    name: req.body.name,
    isActive: true,
    _id: { $ne: req.params.id }
  });
  if (nameConflict) {
    return res.status(409).json({
      success: false,
      error: "Export with this name already exists",
      code: "DUPLICATE_NAME"
    });
  }
}

// Merge filters if provided (deep merge)
const updatedFilters = req.body.filters
  ? { ...existing.filters.toObject(), ...req.body.filters }
  : existing.filters;

// Update document
const updated = await ExportConfig.findByIdAndUpdate(
  req.params.id,
  {
    $set: {
      ...(req.body.name && { name: req.body.name.trim() }),
      ...(req.body.description !== undefined && { description: req.body.description?.trim() || null }),
      ...(req.body.preset && { preset: req.body.preset }),
      ...(req.body.selectedFields && { selectedFields: req.body.selectedFields }),
      ...(req.body.filters && { filters: updatedFilters }),
      ...(req.body.pricelistPriority && { pricelistPriority: req.body.pricelistPriority }),
      updatedAt: new Date()
    }
  },
  { new: true, runValidators: true }
);
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "_id": "65c4a1b2c3d4e5f6a7b8c9d0",
    "name": "Updated Export Name",
    "description": "New description",
    "preset": "shopify",
    "selectedFields": ["..."],
    "filters": {
      "search": "",
      "stockStatus": "all",
      "minPrice": "",
      "maxPrice": "",
      "category": "all",
      "aiExportId": "all",
      "aiCategory": "all",
      "showNew": false,
      "showRecommended": false,
      "publishedOnly": false
    },
    "pricelistPriority": ["..."],
    "isActive": true,
    "createdAt": "2026-02-06T10:30:00.000Z",
    "updatedAt": "2026-02-06T11:45:00.000Z"
  }
}
```

---

### 5. DELETE /custom-export/:id - Delete Configuration

**Purpose:** Delete (soft or hard) an export configuration.

**Request:**
```http
DELETE /custom-export/65c4a1b2c3d4e5f6a7b8c9d0
DELETE /custom-export/65c4a1b2c3d4e5f6a7b8c9d0?hard=true
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hard` | boolean | `false` | If true, permanently delete; otherwise soft delete |

**Server Processing:**
```javascript
if (req.query.hard === 'true') {
  // Hard delete - permanently remove from database
  const result = await ExportConfig.findByIdAndDelete(req.params.id);
  if (!result) {
    return res.status(404).json({
      success: false,
      error: "Export configuration not found",
      code: "NOT_FOUND"
    });
  }
} else {
  // Soft delete - set isActive to false
  const result = await ExportConfig.findByIdAndUpdate(
    req.params.id,
    { $set: { isActive: false, updatedAt: new Date() } }
  );
  if (!result) {
    return res.status(404).json({
      success: false,
      error: "Export configuration not found",
      code: "NOT_FOUND"
    });
  }
}
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "message": "Export configuration deleted"
}
```

**Frontend Usage:**
```javascript
// In ExportPage.js - deleteExport()
const deleteExport = async (id) => {
  try {
    const response = await fetch(`${apiUrl}/custom-export/${id}`, {
      method: "DELETE"
    });
    if (response.ok) {
      setSavedExports((prev) => prev.filter((e) => e._id !== id));
    }
  } catch (error) {
    console.error("Failed to delete:", error);
  }
};
```

---

### 6. GET /custom-export/:id/csv - Generate CSV Export

**Purpose:** Generate and download CSV data based on saved configuration.

**Request:**
```http
GET /custom-export/65c4a1b2c3d4e5f6a7b8c9d0/csv
GET /custom-export/65c4a1b2c3d4e5f6a7b8c9d0/csv?download=true
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `download` | boolean | `false` | If true, set Content-Disposition for file download |

**Server Processing:**

1. **Load configuration:**
   ```javascript
   const config = await ExportConfig.findOne({
     _id: req.params.id,
     isActive: true
   });
   ```

2. **Load product data:**
   ```javascript
   const products = await Product.find({ active: true });
   ```

3. **Apply filters** (see [CSV Generation Logic](#csv-generation-logic))

4. **Generate CSV:**
   ```javascript
   const csvData = generateCSV(filteredProducts, config);
   ```

5. **Send response:**
   ```javascript
   const filename = `${config.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.csv`;

   res.setHeader('Content-Type', 'text/csv; charset=utf-8');

   if (req.query.download === 'true') {
     res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
   }

   // Add BOM for Excel UTF-8 compatibility
   res.send('\ufeff' + csvData);
   ```

**Response:**
- Content-Type: `text/csv; charset=utf-8`
- Body: CSV data with BOM prefix

```csv
Handle,Title,Body (HTML),Vendor,Tags (Categories),Published,Variant SKU,Variant Title,Variant Price,Inventory Qty,Barcode,Image Src
patrik-s-wave-2026,"Patrik S-Wave 2026","<p>High-performance wave board...</p>","Patrik International","Boards, Wave",TRUE,PSW26-75,75L,1299.00,5,8594188420123,https://cdn.example.com/s-wave-2026.jpg
patrik-s-wave-2026,,,,,,PSW26-85,85L,1299.00,3,8594188420124,https://cdn.example.com/s-wave-2026-85.jpg
```

---

### 7. GET /custom-export/:id/json - Generate JSON Export

**Purpose:** Get export data as JSON for API integrations.

**Request:**
```http
GET /custom-export/65c4a1b2c3d4e5f6a7b8c9d0/json
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "exportName": "My Shopify Export",
  "exportId": "65c4a1b2c3d4e5f6a7b8c9d0",
  "generatedAt": "2026-02-06T12:00:00.000Z",
  "preset": "shopify",
  "totalProducts": 45,
  "totalRows": 128,
  "columns": ["handle", "title", "body_html", "vendor", "tags", "published", "variant_sku", "variant_title", "variant_price", "variant_inventory_qty", "variant_barcode", "image_src"],
  "data": [
    {
      "handle": "patrik-s-wave-2026",
      "title": "Patrik S-Wave 2026",
      "body_html": "<p>High-performance wave board...</p>",
      "vendor": "Patrik International",
      "tags": "Boards, Wave",
      "published": "TRUE",
      "variant_sku": "PSW26-75",
      "variant_title": "75L",
      "variant_price": "1299.00",
      "variant_inventory_qty": "5",
      "variant_barcode": "8594188420123",
      "image_src": "https://cdn.example.com/s-wave-2026.jpg"
    }
  ]
}
```

---

## Data Flow

### Save Configuration Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. User configures export:                                                  │
│     - Selects preset (shopify/simple/detailed/inventory)                    │
│     - Toggles fields on/off                                                  │
│     - Sets filters (search, stock, price, categories)                       │
│     - Reorders pricelists via drag & drop                                   │
│                                                                              │
│  2. User clicks "Save Export"                                               │
│                                                                              │
│  3. handleSaveExport() collects state:                                      │
│     const exportConfig = {                                                  │
│       name: exportName,                                                     │
│       description: exportDescription,                                       │
│       preset: selectedPreset,        // "shopify"                           │
│       selectedFields: selectedFields, // ["handle", "title", ...]          │
│       filters: filters,               // { stockStatus: "all", ... }       │
│       pricelistPriority: pricelistPriority // [{ name, enabled, priority }]│
│     };                                                                       │
│                                                                              │
│  4. POST request to API                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               BACKEND                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  5. Receive POST /custom-export                                             │
│                                                                              │
│  6. Validate request body:                                                  │
│     - name: required, string, 1-100 chars, unique                          │
│     - preset: required, enum                                                │
│     - selectedFields: required, array, min 1                               │
│     - filters: required, object with all keys                              │
│     - pricelistPriority: required, array                                   │
│                                                                              │
│  7. Check for duplicate name                                                │
│                                                                              │
│  8. Create MongoDB document with timestamps                                 │
│                                                                              │
│  9. Save to database                                                        │
│                                                                              │
│  10. Return created document                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DATABASE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Collection: export_configs                                                 │
│                                                                              │
│  Document:                                                                   │
│  {                                                                           │
│    _id: ObjectId("65c4a1b2c3d4e5f6a7b8c9d0"),                              │
│    name: "My Shopify Export",                                               │
│    description: "Weekly export",                                            │
│    preset: "shopify",                                                       │
│    selectedFields: ["handle", "title", "body_html", ...],                  │
│    filters: {                                                               │
│      search: "",                                                            │
│      stockStatus: "in_stock",                                               │
│      minPrice: "",                                                          │
│      maxPrice: "",                                                          │
│      category: "all",                                                       │
│      aiExportId: "all",                                                     │
│      aiCategory: "all",                                                     │
│      showNew: false,                                                        │
│      showRecommended: false,                                                │
│      publishedOnly: true                                                    │
│    },                                                                        │
│    pricelistPriority: [                                                     │
│      { name: "RRP 2026", enabled: true, priority: 0 },                     │
│      { name: "RRP 2025", enabled: true, priority: 1 }                      │
│    ],                                                                        │
│    isActive: true,                                                          │
│    createdAt: ISODate("2026-02-06T10:30:00.000Z"),                         │
│    updatedAt: ISODate("2026-02-06T10:30:00.000Z")                          │
│  }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Load Configuration Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. User switches to "Saved Exports" tab                                    │
│                                                                              │
│  2. useEffect triggers loadSavedExports()                                   │
│                                                                              │
│  3. GET /custom-export                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               BACKEND                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  4. Query: ExportConfig.find({ isActive: true })                           │
│     Select: _id, name, description, preset, selectedFields, createdAt      │
│     Sort: -createdAt (newest first)                                         │
│                                                                              │
│  5. Return array of configs                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  6. setSavedExports(result.data)                                            │
│                                                                              │
│  7. Render cards showing name, preset, field count, date                    │
│                                                                              │
│  8. User clicks "Load" on a saved export                                    │
│                                                                              │
│  9. loadExportConfig(config) applies settings:                              │
│     - setSelectedPreset(config.preset)                                      │
│     - setSelectedFields(config.selectedFields)                              │
│     - setFilters({ ...defaults, ...config.filters })                       │
│     - setPricelistPriority(config.pricelistPriority)                       │
│     - setActiveTab("configure")                                             │
│                                                                              │
│  10. UI updates to show loaded configuration                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Validation Rules

### Name

| Rule | Value | Error Message |
|------|-------|---------------|
| Required | Yes | "Name is required" |
| Type | String | "Name must be a string" |
| Min Length | 1 | "Name cannot be empty" |
| Max Length | 100 | "Name cannot exceed 100 characters" |
| Unique | Yes (within active) | "Export with this name already exists" |
| Trim | Yes | - |

### Description

| Rule | Value | Error Message |
|------|-------|---------------|
| Required | No | - |
| Type | String or null | "Description must be a string" |
| Max Length | 500 | "Description cannot exceed 500 characters" |
| Trim | Yes | - |

### Preset

| Rule | Value | Error Message |
|------|-------|---------------|
| Required | Yes | "Preset is required" |
| Enum | shopify, simple, detailed, inventory | "Invalid preset type" |

### Selected Fields

| Rule | Value | Error Message |
|------|-------|---------------|
| Required | Yes | "Selected fields are required" |
| Type | Array | "Selected fields must be an array" |
| Min Length | 1 | "At least one field must be selected" |
| Valid Keys | Must match preset's available fields | "Invalid field: {key}" |

### Filters

| Field | Type | Default | Validation |
|-------|------|---------|------------|
| search | string | "" | Max 200 chars |
| stockStatus | enum | "all" | "all", "in_stock", "out_of_stock" |
| minPrice | string | "" | Empty or valid number >= 0 |
| maxPrice | string | "" | Empty or valid number >= 0 |
| category | string | "all" | "all" or non-empty string |
| aiExportId | string | "all" | "all" or valid ObjectId string |
| aiCategory | string | "all" | "all" or valid ObjectId string |
| showNew | boolean | false | - |
| showRecommended | boolean | false | - |
| publishedOnly | boolean | false | - |

### Pricelist Priority

| Rule | Value | Error Message |
|------|-------|---------------|
| Required | Yes | "Pricelist priority is required" |
| Type | Array | "Pricelist priority must be an array" |
| Item.name | Required string | "Pricelist name is required" |
| Item.enabled | Boolean | Defaults to true |
| Item.priority | Number | Auto-assigned from array index |

---

## CSV Generation Logic

### Shopify Format Special Rules

For the Shopify preset, the CSV follows Shopify's import format requirements:

1. **Product-level fields** (title, body_html, vendor, type, tags, published) only appear on the **first row** of each product
2. **Variant-level fields** (variant_sku, variant_title, variant_price, etc.) appear on **every row**
3. **Handle** appears on **every row** (links variants to product)
4. **Multiple images** generate additional rows with only handle + image_src

```javascript
// Shopify CSV generation logic
function generateShopifyCSV(products, config) {
  const rows = [];

  for (const product of products) {
    const variants = product.child_products || [];
    const allImages = [...new Set([
      ...(product.images || []),
      ...variants.flatMap(v => v.images || [])
    ])];

    const maxRows = Math.max(variants.length, allImages.length, 1);

    for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
      const row = {};
      const variant = variants[rowIdx] || null;
      const isFirstRow = rowIdx === 0;
      const isImageOnlyRow = !variant && rowIdx < allImages.length;
      const currentImage = allImages[rowIdx] || "";

      for (const fieldKey of config.selectedFields) {
        if (isImageOnlyRow) {
          // Image-only rows: only handle and image fields
          row[fieldKey] = fieldKey === "handle" ? product.token :
                          fieldKey === "image_src" ? currentImage :
                          fieldKey === "image_alt_text" ? product.product_name : "";
        } else {
          // Regular rows
          const isProductField = ["title", "body_html", "vendor", "type", "tags", "published"].includes(fieldKey);

          if (isProductField && !isFirstRow) {
            row[fieldKey] = ""; // Product fields only on first row
          } else {
            row[fieldKey] = getFieldValue(fieldKey, product, variant, config);
          }
        }
      }

      rows.push(row);
    }
  }

  return rows;
}
```

### Field Value Mapping

```javascript
const FIELD_MAPPINGS = {
  // Shopify fields
  handle: (p, v) => p.token || "",
  title: (p, v) => p.product_name || "",
  body_html: (p, v) => p.detailed_description || p.short_description || "",
  vendor: () => "Patrik International",
  type: (p, v) => p.categories?.[0] || "",
  tags: (p, v) => [...(p.categories || []), p.new ? "new" : "", p.recomended ? "recommended" : ""].filter(Boolean).join(", "),
  published: (p, v) => p.published ? "TRUE" : "FALSE",
  variant_sku: (p, v) => v?.code || "",
  variant_title: (p, v) => v?.product_name || "",
  variant_price: (p, v, priceInfo) => priceInfo.price.toFixed(2),
  variant_compare_at_price: (p, v, priceInfo, config) => getCompareAtPrice(v, config),
  variant_inventory_qty: (p, v) => v?.stock_amount || 0,
  variant_barcode: (p, v) => v?.ean_code || "",
  image_src: (p, v, priceInfo, config, image) => image || "",
  image_alt_text: (p, v) => p.product_name || "",
  variant_image: (p, v) => v?.images?.[0] || "",

  // Simple/Detailed fields
  product_name: (p, v) => p.product_name || "",
  variant_name: (p, v) => v?.product_name || "",
  sku: (p, v) => v?.code || "",
  ean: (p, v) => v?.ean_code || "",
  price: (p, v, priceInfo) => priceInfo.price.toFixed(2),
  pricelist_name: (p, v, priceInfo) => priceInfo.name || "",
  vat: (p, v, priceInfo) => priceInfo.vat,
  price_with_vat: (p, v, priceInfo) => (priceInfo.price * (1 + priceInfo.vat / 100)).toFixed(2),
  stock: (p, v) => v?.stock_amount || 0,
  stock_value: (p, v, priceInfo) => ((v?.stock_amount || 0) * priceInfo.price).toFixed(2),
  in_stock: (p, v) => (v?.stock_amount || 0) > 0 ? "Yes" : "No",
  categories: (p, v) => (p.categories || []).join("; "),
  // ... more fields
};
```

---

## Error Handling

### Error Response Format

```json
{
  "success": false,
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": {}  // Optional additional context
}
```

### Error Codes

| Code | HTTP Status | Description | Example |
|------|-------------|-------------|---------|
| `VALIDATION_ERROR` | 400 | Request body validation failed | Missing required field |
| `INVALID_ID` | 400 | Invalid MongoDB ObjectId format | "abc" instead of valid ObjectId |
| `NOT_FOUND` | 404 | Resource doesn't exist or is inactive | Deleted export |
| `DUPLICATE_NAME` | 409 | Export name already exists | Creating with existing name |
| `SERVER_ERROR` | 500 | Unexpected server error | Database connection failure |

### Validation Error Details

```json
{
  "success": false,
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": {
    "fields": [
      { "field": "name", "message": "Name is required" },
      { "field": "selectedFields", "message": "At least one field must be selected" }
    ]
  }
}
```

---

## Implementation Examples

### Express.js Router

```javascript
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const router = express.Router();

const ExportConfig = require('../models/ExportConfig');

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: { fields: errors.array() }
    });
  }
  next();
};

// Create
router.post('/custom-export',
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('preset').isIn(['shopify', 'simple', 'detailed', 'inventory']),
  body('selectedFields').isArray({ min: 1 }),
  body('filters').isObject(),
  body('pricelistPriority').isArray(),
  validate,
  async (req, res) => {
    try {
      // Check duplicate
      const existing = await ExportConfig.findOne({
        name: req.body.name,
        isActive: true
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: "Export with this name already exists",
          code: "DUPLICATE_NAME"
        });
      }

      const config = new ExportConfig({
        name: req.body.name,
        description: req.body.description || null,
        preset: req.body.preset,
        selectedFields: req.body.selectedFields,
        filters: req.body.filters,
        pricelistPriority: req.body.pricelistPriority,
        isActive: true
      });

      await config.save();
      res.status(201).json({ success: true, data: config });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: "SERVER_ERROR"
      });
    }
  }
);

// List
router.get('/custom-export', async (req, res) => {
  try {
    const query = { isActive: req.query.active !== 'false' };
    if (req.query.preset) query.preset = req.query.preset;

    const configs = await ExportConfig
      .find(query)
      .sort('-createdAt')
      .limit(parseInt(req.query.limit) || 50);

    res.json({ success: true, count: configs.length, data: configs });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      code: "SERVER_ERROR"
    });
  }
});

// Get by ID
router.get('/custom-export/:id',
  param('id').custom(v => mongoose.Types.ObjectId.isValid(v)),
  validate,
  async (req, res) => {
    try {
      const config = await ExportConfig.findOne({
        _id: req.params.id,
        isActive: true
      });

      if (!config) {
        return res.status(404).json({
          success: false,
          error: "Export configuration not found",
          code: "NOT_FOUND"
        });
      }

      res.json({ success: true, data: config });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: "SERVER_ERROR"
      });
    }
  }
);

// Update
router.put('/custom-export/:id',
  param('id').custom(v => mongoose.Types.ObjectId.isValid(v)),
  validate,
  async (req, res) => {
    try {
      const config = await ExportConfig.findByIdAndUpdate(
        req.params.id,
        { ...req.body, updatedAt: new Date() },
        { new: true, runValidators: true }
      );

      if (!config) {
        return res.status(404).json({
          success: false,
          error: "Export configuration not found",
          code: "NOT_FOUND"
        });
      }

      res.json({ success: true, data: config });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: "SERVER_ERROR"
      });
    }
  }
);

// Delete
router.delete('/custom-export/:id',
  param('id').custom(v => mongoose.Types.ObjectId.isValid(v)),
  validate,
  async (req, res) => {
    try {
      const result = req.query.hard === 'true'
        ? await ExportConfig.findByIdAndDelete(req.params.id)
        : await ExportConfig.findByIdAndUpdate(req.params.id, { isActive: false });

      if (!result) {
        return res.status(404).json({
          success: false,
          error: "Export configuration not found",
          code: "NOT_FOUND"
        });
      }

      res.json({ success: true, message: "Export configuration deleted" });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: "SERVER_ERROR"
      });
    }
  }
);

module.exports = router;
```

### MongoDB Schema

```javascript
const mongoose = require('mongoose');

const pricelistConfigSchema = new mongoose.Schema({
  name: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  priority: { type: Number, required: true }
}, { _id: false });

const filtersSchema = new mongoose.Schema({
  search: { type: String, default: "" },
  stockStatus: {
    type: String,
    enum: ["all", "in_stock", "out_of_stock"],
    default: "all"
  },
  minPrice: { type: String, default: "" },
  maxPrice: { type: String, default: "" },
  category: { type: String, default: "all" },
  aiExportId: { type: String, default: "all" },
  aiCategory: { type: String, default: "all" },
  showNew: { type: Boolean, default: false },
  showRecommended: { type: Boolean, default: false },
  publishedOnly: { type: Boolean, default: false }
}, { _id: false });

const exportConfigSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Name is required"],
    trim: true,
    maxlength: [100, "Name cannot exceed 100 characters"]
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, "Description cannot exceed 500 characters"],
    default: null
  },
  preset: {
    type: String,
    required: [true, "Preset is required"],
    enum: {
      values: ["shopify", "simple", "detailed", "inventory"],
      message: "Invalid preset type"
    }
  },
  selectedFields: {
    type: [String],
    required: [true, "Selected fields are required"],
    validate: {
      validator: v => v.length > 0,
      message: "At least one field must be selected"
    }
  },
  filters: {
    type: filtersSchema,
    required: true,
    default: () => ({})
  },
  pricelistPriority: {
    type: [pricelistConfigSchema],
    required: true,
    default: []
  },
  isActive: { type: Boolean, default: true },
  createdBy: { type: String, default: null }
}, {
  timestamps: true,
  collection: 'export_configs'
});

// Compound unique index on name + isActive
exportConfigSchema.index(
  { name: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

module.exports = mongoose.model('ExportConfig', exportConfigSchema);
```

---

## Summary

This API provides complete CRUD operations for export configurations with:

- **Robust validation** at all layers
- **Soft delete** support for data recovery
- **Flexible filtering** on list endpoints
- **Shopify-compatible** CSV generation
- **Consistent error handling** with codes
- **Full TypeScript types** for frontend integration
