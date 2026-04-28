# Custom Exports API

The Custom Export API lets you save, manage, and execute export configurations. Each configuration defines a preset template, field selection, product filters, and pricelist priority -- then generates CSV, JSON, or XML on demand.

---

## Table of Contents

- [Endpoints Overview](#endpoints-overview)
- [Data Models](#data-models)
- [CRUD Endpoints](#crud-endpoints)
- [Download Endpoints](#download-endpoints)
- [Filter Logic](#filter-logic)
- [CSV Generation](#csv-generation)
- [Error Handling](#error-handling)

---

## Endpoints Overview

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/export/custom-export` | Create a configuration |
| `GET` | `/api/export/custom-export` | List all configurations |
| `GET` | `/api/export/custom-export/:id` | Get a single configuration |
| `PUT` | `/api/export/custom-export/:id` | Update a configuration |
| `DELETE` | `/api/export/custom-export/:id` | Delete a configuration (soft) |
| `GET` | `/api/export/custom-export/:id/csv` | Download as CSV |
| `GET` | `/api/export/custom-export/:id/json` | Download as JSON |
| `GET` | `/api/export/custom-export/:id/xml` | Download as XML |

All endpoints use **Dual Auth** (JWT bearer token or API key).

---

## Data Models

### ExportConfiguration

```typescript
interface ExportConfiguration {
  _id: ObjectId;                    // Auto-generated
  name: string;                     // Required, unique, 1-100 chars
  description: string | null;       // Optional, max 500 chars
  preset: PresetType;               // Required
  selectedFields: string[];         // Required, min 1 field
  filters: ExportFilters;           // Required
  pricelistPriority: PricelistConfig[];  // Required, ordered
  isActive: boolean;                // Default: true (soft delete flag)
  createdBy: string | null;         // Optional user identifier
  createdAt: Date;                  // Auto-set
  updatedAt: Date;                  // Auto-updated
}
```

### Presets

| Preset | Description | Typical use case |
|--------|-------------|------------------|
| `shopify` | Shopify CSV import format | Bulk product import to Shopify |
| `simple` | Basic product list | Quick product overview |
| `detailed` | Full product data | Complete data export |
| `inventory` | Stock & pricing focus | Shopify inventory import |

> The **inventory** preset uses a dedicated code path with fixed columns for Shopify inventory import. Only CSV export is supported for this preset.

### ExportFilters

```typescript
interface ExportFilters {
  search: string;                   // Free text, default: ""
  stockStatus: "all" | "in_stock" | "out_of_stock";
  minPrice: string;                 // Numeric string or ""
  maxPrice: string;                 // Numeric string or ""
  category: string;                 // "all" or category name
  aiExportId: string;               // "all" or ObjectId string
  aiCategory: string;               // "all" or ObjectId string
  showNew: boolean;                 // Default: false
  showRecommended: boolean;         // Default: false
  publishedOnly: boolean;           // Default: false. Cascades into variants:
                                    // excludes unpublished parents AND strips
                                    // unpublished variants from child_products
                                    // before all other filters and row generation.
}
```

### PricelistConfig

```typescript
interface PricelistConfig {
  name: string;       // Pricelist name, e.g., "RRP 2026"
  enabled: boolean;   // Whether to use this pricelist
  priority: number;   // 0-based index, lower = higher priority
}
```

**Price resolution:** Enabled pricelists are sorted by priority (ascending). The first pricelist with a price for the variant wins. If none match, falls back to the variant's first available pricelist.

---

## CRUD Endpoints

### Create Configuration

```http
POST /api/export/custom-export
Content-Type: application/json
```

**Body:**

```json
{
  "name": "My Shopify Export",
  "description": "Weekly export for online store",
  "preset": "shopify",
  "selectedFields": ["handle", "title", "body_html", "variant_sku", "variant_price", "image_src"],
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
    { "name": "RRP 2025", "enabled": true, "priority": 1 }
  ]
}
```

**Response `201 Created`:**

```json
{
  "success": true,
  "data": {
    "_id": "65c4a1b2c3d4e5f6a7b8c9d0",
    "name": "My Shopify Export",
    "preset": "shopify",
    "...": "..."
  }
}
```

Returns `409` if the name already exists among active configurations.

### List Configurations

```http
GET /api/export/custom-export
GET /api/export/custom-export?preset=shopify&active=true&sort=-createdAt&limit=50
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `active` | boolean | `true` | Filter by active status |
| `preset` | string | -- | Filter by preset type |
| `sort` | string | `-createdAt` | Sort field (prefix `-` for descending) |
| `limit` | number | `50` | Max results |

**Response `200`:**

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
      "selectedFields": ["handle", "title", "..."],
      "createdAt": "2026-02-06T10:30:00.000Z",
      "updatedAt": "2026-02-06T10:30:00.000Z"
    }
  ]
}
```

### Get Single Configuration

```http
GET /api/export/custom-export/:id
```

Returns the full configuration document. Returns `404` if not found or inactive.

### Update Configuration

```http
PUT /api/export/custom-export/:id
Content-Type: application/json
```

Supports **partial updates** -- only include fields you want to change. Filters are deep-merged with existing values.

```json
{
  "name": "Updated Name",
  "filters": {
    "stockStatus": "all"
  }
}
```

### Delete Configuration

```http
DELETE /api/export/custom-export/:id
DELETE /api/export/custom-export/:id?hard=true
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hard` | boolean | `false` | Permanently delete instead of soft delete |

---

## Download Endpoints

### CSV Export

```http
GET /api/export/custom-export/:id/csv
GET /api/export/custom-export/:id/csv?download=true
```

Returns CSV data with UTF-8 BOM for Excel compatibility.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `download` | boolean | `false` | Set `Content-Disposition` for file download |

**Response headers:**
- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="export-name-2026-02-06.csv"` (when `download=true`)

### JSON Export

```http
GET /api/export/custom-export/:id/json
```

**Response `200`:**

```json
{
  "success": true,
  "exportName": "My Shopify Export",
  "exportId": "65c4a1b2c3d4e5f6a7b8c9d0",
  "generatedAt": "2026-02-06T12:00:00.000Z",
  "preset": "shopify",
  "totalProducts": 45,
  "totalRows": 128,
  "columns": ["handle", "title", "variant_sku", "..."],
  "data": [
    {
      "handle": "patrik-s-wave-2026",
      "title": "Patrik S-Wave 2026",
      "variant_sku": "PSW26-75",
      "...": "..."
    }
  ]
}
```

### XML Export

```http
GET /api/export/custom-export/:id/xml
```

Returns the same data as JSON but serialized as XML.

---

## Filter Logic

All filters are combined with **AND** logic:

```
product matches IF:
  (search is empty OR name/code/sku/ean contains search)
  AND (stockStatus is "all" OR matches stock condition)
  AND (minPrice is empty OR product max price >= minPrice)
  AND (maxPrice is empty OR product min price <= maxPrice)
  AND (category is "all" OR product.categories includes category)
  AND (aiExportId is "all" OR product.ai_categories has matching exportId)
  AND (aiCategory is "all" OR product.ai_categories has matching categoryId)
  AND (showNew is false OR product.new is true)
  AND (showRecommended is false OR product.recomended is true)
  AND (publishedOnly is false OR product.published is true)

If publishedOnly is true, the filter also narrows each surviving parent's
child_products to only those variants whose own `published` field is true —
all downstream filters (stock, price, image, search) and row generation
operate on this narrowed set, so unpublished variants never appear in output.
```

---

## CSV Generation

### Shopify Format

The Shopify preset follows Shopify's CSV import format:

1. **Product-level fields** (title, body_html, vendor, type, tags, published) appear only on the **first row** of each product
2. **Variant-level fields** (variant_sku, variant_title, variant_price, etc.) appear on **every row**
3. **Handle** appears on **every row** (links variants to their product)
4. **Multiple images** generate additional rows with only handle + image_src

### Inventory Format

The inventory preset generates a fixed-column Shopify inventory import CSV:

```
Handle, Title, Option1 Name, Option1 Value, ..., SKU, HS Code, COO, {locationName}
```

The last column header is the `inventoryLocationName` from the config -- it must exactly match the Shopify location name (case-sensitive). Field selection is ignored for this preset.

---

## Error Handling

### Error Response Format

```json
{
  "success": false,
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```

### Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `VALIDATION_ERROR` | 400 | Request body validation failed |
| `INVALID_ID` | 400 | Invalid MongoDB ObjectId format |
| `NOT_FOUND` | 404 | Resource doesn't exist or is inactive |
| `DUPLICATE_NAME` | 409 | Export name already exists |
| `SERVER_ERROR` | 500 | Unexpected server error |

### Validation Rules

| Field | Rules |
|-------|-------|
| `name` | Required, string, 1-100 chars, unique among active configs, trimmed |
| `description` | Optional, string or null, max 500 chars, trimmed |
| `preset` | Required, one of: `shopify`, `simple`, `detailed`, `inventory` |
| `selectedFields` | Required, array with at least 1 field |
| `filters` | Required, object with all filter keys |
| `pricelistPriority` | Required, array of `{ name, enabled, priority }` objects |
