## Members

<dl>
<dt><a href="#db">db</a> : <code><a href="#MongoDb">MongoDb</a></code></dt>
<dd></dd>
</dl>

## Constants

<dl>
<dt><a href="#mongoUri">mongoUri</a> : <code>string</code></dt>
<dd><p>MongoDB connection URI.</p>
</dd>
<dt><a href="#dbName">dbName</a> : <code>string</code></dt>
<dd><p>MongoDB database name.</p>
</dd>
</dl>

## Functions

<dl>
<dt><a href="#getAllCategories">getAllCategories()</a></dt>
<dd><p>Handles the request to retrieve all categories.</p>
</dd>
<dt><a href="#getCategoriesByExportId">getCategoriesByExportId()</a></dt>
<dd><p>Handles the request to retrieve categories for a specific export ID.</p>
</dd>
<dt><a href="#logAiUsage">logAiUsage(operationId, usageMetadata, modelName)</a> ⇒ <code>Promise.&lt;void&gt;</code></dt>
<dd><p>Logs AI token usage to the &#39;aiAnalytics&#39; collection in MongoDB.</p>
<p>This function is designed to be a non-critical, &quot;fire-and-forget&quot; operation.
If it fails, it will log an error to the console but will not throw an exception,
ensuring that the primary application flow is not interrupted.</p>
</dd>
<dt><a href="#processBatch">processBatch(products, validCategories, exportId)</a> ⇒ <code>Promise.&lt;Array.&lt;{code: string, catId: number}&gt;&gt;</code></dt>
<dd><p>Processes a batch of products to identify their categories using the Generative AI model.</p>
</dd>
<dt><a href="#identifyProductCategories">identifyProductCategories(exportId)</a></dt>
<dd><p>Identifies and saves categories for products based on a given export ID.</p>
</dd>
<dt><a href="#getCategoryNameForProductCode">getCategoryNameForProductCode(productCode, exportId)</a> ⇒ <code>Promise.&lt;(string|null)&gt;</code></dt>
<dd><p>Retrieves the category name for a specific product code and export ID from the database.</p>
</dd>
<dt><a href="#saveAnalyticsData">saveAnalyticsData(logData)</a></dt>
<dd><p>Saves a single API log entry to the database.</p>
</dd>
<dt><a href="#getAllCategories">getAllCategories()</a> ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code></dt>
<dd><p>Retrieves all categories from the &#39;categories&#39; collection.</p>
</dd>
<dt><a href="#getCategoriesByExportId">getCategoriesByExportId(exportId)</a> ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code></dt>
<dd><p>Retrieves all category documents for a specific export ID.</p>
</dd>
<dt><a href="#connectToDb">connectToDb()</a> ⇒ <code>Promise.&lt;void&gt;</code></dt>
<dd><p>Connects to the MongoDB database.
It&#39;s recommended to call this once when the application starts.</p>
</dd>
<dt><a href="#getDb">getDb()</a> ⇒ <code><a href="#MongoDb">MongoDb</a></code></dt>
<dd><p>Returns the database instance. Throws an error if not connected.</p>
</dd>
<dt><a href="#getAllExports">getAllExports()</a> ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code></dt>
<dd><p>Retrieves all documents from the &#39;exports&#39; collection.</p>
</dd>
<dt><a href="#getAiEnabledExports">getAiEnabledExports()</a> ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code></dt>
<dd><p>Retrieves all documents from the &#39;exports&#39; collection where AI categorization is enabled.</p>
</dd>
<dt><a href="#getExportById">getExportById(id)</a> ⇒ <code>Promise.&lt;(Object|null)&gt;</code></dt>
<dd><p>Retrieves an export document by its ID.</p>
</dd>
<dt><a href="#getProductPricelist">getProductPricelist(code)</a> ⇒ <code>Promise.&lt;Array.&lt;{title: string, valid_from: string, price: number, vat: number}&gt;&gt;</code></dt>
<dd><p>Fetches the pricelist for a specific product from the Metakocka API.</p>
</dd>
<dt><a href="#getWarehouseStock">getWarehouseStock([warehouseId])</a> ⇒ <code>Promise.&lt;Map.&lt;string, {code: string, amount: number, count_code: string, mk_id: string}&gt;&gt;</code></dt>
<dd><p>Fetches all stock for a given warehouse from the Metakocka API.
It handles pagination by making multiple requests until all stock is retrieved.
The stock is returned as a Map for efficient O(1) lookups by product code.</p>
</dd>
<dt><a href="#getProductStock">getProductStock(warehouseStock, code)</a> ⇒ <code>Object</code> | <code>undefined</code></dt>
<dd><p>Finds the stock information for a specific product code within a given stock list.</p>
</dd>
<dt><a href="#getProductStockAmount">getProductStockAmount(warehouseStock, code)</a> ⇒ <code>number</code></dt>
<dd><p>Finds the stock amount for a specific product code.</p>
</dd>
<dt><a href="#getAuthCookie">getAuthCookie()</a> ⇒ <code>string</code></dt>
<dd><p>Creates the authentication cookie string required for PNV API requests.</p>
</dd>
<dt><a href="#fetchPnvDownloadLink">fetchPnvDownloadLink(cookie)</a> ⇒ <code>Promise.&lt;string&gt;</code></dt>
<dd><p>Triggers the generation of a products export file on the PNV server and fetches the resulting download link.</p>
</dd>
<dt><a href="#downloadFile">downloadFile(fileUrl, savePath, cookie)</a> ⇒ <code>Promise.&lt;void&gt;</code></dt>
<dd><p>Downloads a file from a given URL and saves it to a specified path.</p>
</dd>
<dt><a href="#runPnvProductSync">runPnvProductSync()</a></dt>
<dd><p>Main service function to download the PNV products export file.</p>
</dd>
<dt><a href="#parseProductsCsv">parseProductsCsv()</a> ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code></dt>
<dd><p>Reads and parses the products.csv file.</p>
</dd>
<dt><a href="#mapProduct">mapProduct(product, columnMapping, warehouseStock)</a> ⇒ <code>Promise.&lt;Object&gt;</code></dt>
<dd><p>Maps a single product object from its CSV structure to a JSON object based on the provided mapping.</p>
</dd>
<dt><a href="#processPnvProductExport">processPnvProductExport([columnMapping])</a></dt>
<dd><p>Main function to parse products and structure them into a parent-child hierarchy.
It returns an array of parent products, each containing an array of its child products.
The resulting data is then saved to the &#39;products&#39; collection in MongoDB.</p>
</dd>
<dt><a href="#splitStringByBackslash">splitStringByBackslash(value)</a> ⇒ <code>Array.&lt;string&gt;</code></dt>
<dd><p>Splits a string by the backslash character, trims each resulting substring, and filters out any empty strings.
If the input value is falsy, it returns an empty array.</p>
</dd>
<dt><a href="#transformToBoolean">transformToBoolean(value)</a> ⇒ <code>boolean</code></dt>
<dd><p>Transforms a value to its boolean equivalent. &quot;1&quot; or 1 becomes true, &quot;0&quot; or 0 becomes false.
Any other value will result in false.</p>
</dd>
<dt><a href="#getAllProducts">getAllProducts()</a> ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code></dt>
<dd><p>Fetches all products from the database.</p>
</dd>
<dt><a href="#getProductByIdentifier">getProductByIdentifier(identifier)</a> ⇒ <code>Promise.&lt;(Object|null)&gt;</code></dt>
<dd><p>Fetches a single product from the database by its code or token.
This function searches for the identifier in the main product&#39;s <code>code</code> and <code>token</code> fields,
as well as in the <code>code</code> and <code>token</code> fields of any child products.</p>
</dd>
<dt><a href="#generateProductsTsv">generateProductsTsv(exportId)</a> ⇒ <code>Promise.&lt;string&gt;</code></dt>
<dd><p>Generates a TSV string from the products data.</p>
</dd>
</dl>

## Typedefs

<dl>
<dt><a href="#MongoDb">MongoDb</a> : <code>mongodb.Db</code></dt>
<dd></dd>
</dl>

<a name="db"></a>

## db : [<code>MongoDb</code>](#MongoDb)
**Kind**: global variable  
<a name="mongoUri"></a>

## mongoUri : <code>string</code>
MongoDB connection URI.

**Kind**: global constant  
<a name="dbName"></a>

## dbName : <code>string</code>
MongoDB database name.

**Kind**: global constant  
<a name="getAllCategories"></a>

## getAllCategories()
Handles the request to retrieve all categories.

**Kind**: global function  
<a name="getCategoriesByExportId"></a>

## getCategoriesByExportId()
Handles the request to retrieve categories for a specific export ID.

**Kind**: global function  
<a name="logAiUsage"></a>

## logAiUsage(operationId, usageMetadata, modelName) ⇒ <code>Promise.&lt;void&gt;</code>
Logs AI token usage to the 'aiAnalytics' collection in MongoDB.This function is designed to be a non-critical, "fire-and-forget" operation.If it fails, it will log an error to the console but will not throw an exception,ensuring that the primary application flow is not interrupted.

**Kind**: global function  
**Returns**: <code>Promise.&lt;void&gt;</code> - A promise that resolves when the logging is attempted.  

| Param | Type | Description |
| --- | --- | --- |
| operationId | <code>string</code> | A unique identifier for the operation that used the AI (e.g., 'tris-categorization', 'product-description-generation'). |
| usageMetadata | <code>object</code> | The usage metadata object from the AI response. |
| usageMetadata.promptTokenCount | <code>number</code> | The number of tokens in the prompt. |
| usageMetadata.candidatesTokenCount | <code>number</code> | The number of tokens in the generated candidates. |
| usageMetadata.totalTokenCount | <code>number</code> | The total number of tokens used. |
| modelName | <code>string</code> | The name of the AI model used for the operation. |

<a name="processBatch"></a>

## processBatch(products, validCategories, exportId) ⇒ <code>Promise.&lt;Array.&lt;{code: string, catId: number}&gt;&gt;</code>
Processes a batch of products to identify their categories using the Generative AI model.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;{code: string, catId: number}&gt;&gt;</code> - A promise that resolves with the categorized results.  

| Param | Type | Description |
| --- | --- | --- |
| products | <code>Array.&lt;Object&gt;</code> | The batch of products to categorize. |
| validCategories | <code>Array.&lt;{id: number, label: string}&gt;</code> | The list of valid categories for the AI to choose from. |
| exportId | <code>string</code> | The identifier for the category export (e.g., 'tris'). |

<a name="identifyProductCategories"></a>

## identifyProductCategories(exportId)
Identifies and saves categories for products based on a given export ID.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| exportId | <code>string</code> | The identifier for the category export (e.g., 'tris'). |

<a name="getCategoryNameForProductCode"></a>

## getCategoryNameForProductCode(productCode, exportId) ⇒ <code>Promise.&lt;(string\|null)&gt;</code>
Retrieves the category name for a specific product code and export ID from the database.

**Kind**: global function  
**Returns**: <code>Promise.&lt;(string\|null)&gt;</code> - A promise that resolves to the category name, or null if not found.  

| Param | Type | Description |
| --- | --- | --- |
| productCode | <code>string</code> | The product code to look up. |
| exportId | <code>string</code> | The identifier for the category export (e.g., 'tris'). |

<a name="saveAnalyticsData"></a>

## saveAnalyticsData(logData)
Saves a single API log entry to the database.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| logData | <code>Object</code> | The data object to insert |

<a name="getAllCategories"></a>

## getAllCategories() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Retrieves all categories from the 'categories' collection.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - A promise that resolves to an array of category documents.  
<a name="getCategoriesByExportId"></a>

## getCategoriesByExportId(exportId) ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Retrieves all category documents for a specific export ID.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - A promise that resolves to an array of category documents.  

| Param | Type | Description |
| --- | --- | --- |
| exportId | <code>string</code> | The ID of the export to retrieve categories for. |

<a name="connectToDb"></a>

## connectToDb() ⇒ <code>Promise.&lt;void&gt;</code>
Connects to the MongoDB database.It's recommended to call this once when the application starts.

**Kind**: global function  
**Returns**: <code>Promise.&lt;void&gt;</code> - A promise that resolves when the connection is established.  
<a name="getDb"></a>

## getDb() ⇒ [<code>MongoDb</code>](#MongoDb)
Returns the database instance. Throws an error if not connected.

**Kind**: global function  
**Returns**: [<code>MongoDb</code>](#MongoDb) - The MongoDB database instance.  
<a name="getAllExports"></a>

## getAllExports() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Retrieves all documents from the 'exports' collection.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - A promise that resolves to an array of export documents.  
<a name="getAiEnabledExports"></a>

## getAiEnabledExports() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Retrieves all documents from the 'exports' collection where AI categorization is enabled.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - A promise that resolves to an array of export documents.  
<a name="getExportById"></a>

## getExportById(id) ⇒ <code>Promise.&lt;(Object\|null)&gt;</code>
Retrieves an export document by its ID.

**Kind**: global function  
**Returns**: <code>Promise.&lt;(Object\|null)&gt;</code> - A promise that resolves to the export document, or null if not found.  

| Param | Type | Description |
| --- | --- | --- |
| id | <code>string</code> | The ID of the export document to retrieve. |

<a name="getProductPricelist"></a>

## getProductPricelist(code) ⇒ <code>Promise.&lt;Array.&lt;{title: string, valid\_from: string, price: number, vat: number}&gt;&gt;</code>
Fetches the pricelist for a specific product from the Metakocka API.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;{title: string, valid\_from: string, price: number, vat: number}&gt;&gt;</code> - A promise that resolves to an array of pricelist objects.  

| Param | Type | Description |
| --- | --- | --- |
| code | <code>string</code> | The product code to fetch the pricelist for. |

<a name="getWarehouseStock"></a>

## getWarehouseStock([warehouseId]) ⇒ <code>Promise.&lt;Map.&lt;string, {code: string, amount: number, count\_code: string, mk\_id: string}&gt;&gt;</code>
Fetches all stock for a given warehouse from the Metakocka API.It handles pagination by making multiple requests until all stock is retrieved.The stock is returned as a Map for efficient O(1) lookups by product code.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Map.&lt;string, {code: string, amount: number, count\_code: string, mk\_id: string}&gt;&gt;</code> - A promise that resolves to a Map of stock items, with product codes as keys.  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| [warehouseId] | <code>string</code> | <code>&quot;warehouse.t4aMainWarehouseId&quot;</code> | The ID of the warehouse to get stock for. Defaults to the main T4A warehouse. |

<a name="getProductStock"></a>

## getProductStock(warehouseStock, code) ⇒ <code>Object</code> \| <code>undefined</code>
Finds the stock information for a specific product code within a given stock list.

**Kind**: global function  
**Returns**: <code>Object</code> \| <code>undefined</code> - The stock item object if found, otherwise undefined.  

| Param | Type | Description |
| --- | --- | --- |
| warehouseStock | <code>Map.&lt;string, {code: string, amount: number, count\_code: string, mk\_id: string}&gt;</code> | The Map of stock items to search through. |
| code | <code>string</code> | The product code to find. |

<a name="getProductStockAmount"></a>

## getProductStockAmount(warehouseStock, code) ⇒ <code>number</code>
Finds the stock amount for a specific product code.

**Kind**: global function  
**Returns**: <code>number</code> - The stock amount if the product is found, otherwise 0.  

| Param | Type | Description |
| --- | --- | --- |
| warehouseStock | <code>Map.&lt;string, {code: string, amount: number, count\_code: string, mk\_id: string}&gt;</code> | The Map of stock items to search through. |
| code | <code>string</code> | The product code to find. |

<a name="getAuthCookie"></a>

## getAuthCookie() ⇒ <code>string</code>
Creates the authentication cookie string required for PNV API requests.

**Kind**: global function  
**Returns**: <code>string</code> - The authentication cookie.  
**Throws**:

- <code>Error</code> If PNV_USER or PNV_PASS environment variables are not set.

<a name="fetchPnvDownloadLink"></a>

## fetchPnvDownloadLink(cookie) ⇒ <code>Promise.&lt;string&gt;</code>
Triggers the generation of a products export file on the PNV server and fetches the resulting download link.

**Kind**: global function  
**Returns**: <code>Promise.&lt;string&gt;</code> - The relative URL path to the download file.  
**Throws**:

- <code>Error</code> If the request fails or the download link is not found in the response.


| Param | Type | Description |
| --- | --- | --- |
| cookie | <code>string</code> | The authentication cookie. This function sends a POST request that initiates the file creation on the remote server. |

<a name="downloadFile"></a>

## downloadFile(fileUrl, savePath, cookie) ⇒ <code>Promise.&lt;void&gt;</code>
Downloads a file from a given URL and saves it to a specified path.

**Kind**: global function  
**Throws**:

- <code>Error</code> If the file download or save operation fails.


| Param | Type | Description |
| --- | --- | --- |
| fileUrl | <code>string</code> | The full URL of the file to download. |
| savePath | <code>string</code> | The local file path to save the downloaded file. |
| cookie | <code>string</code> | The authentication cookie. |

<a name="runPnvProductSync"></a>

## runPnvProductSync()
Main service function to download the PNV products export file.

**Kind**: global function  
<a name="parseProductsCsv"></a>

## parseProductsCsv() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Reads and parses the products.csv file.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - A promise that resolves with an array of product objects.  
<a name="mapProduct"></a>

## mapProduct(product, columnMapping, warehouseStock) ⇒ <code>Promise.&lt;Object&gt;</code>
Maps a single product object from its CSV structure to a JSON object based on the provided mapping.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Object&gt;</code> - A promise that resolves to the mapped product as a JSON object.  

| Param | Type | Description |
| --- | --- | --- |
| product | <code>Object</code> | The product object from the parsed CSV. |
| columnMapping | <code>Array.&lt;Object&gt;</code> | The mapping configuration for transformations. |
| warehouseStock | <code>Map.&lt;string, {code: string, amount: number, count\_code: string, mk\_id: string}&gt;</code> | The Map of stock items. |

<a name="processPnvProductExport"></a>

## processPnvProductExport([columnMapping])
Main function to parse products and structure them into a parent-child hierarchy.It returns an array of parent products, each containing an array of its child products.The resulting data is then saved to the 'products' collection in MongoDB.

**Kind**: global function  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| [columnMapping] | <code>Array.&lt;Object&gt;</code> | <code>productMapping</code> | An array of objects specifying the mapping. |

<a name="splitStringByBackslash"></a>

## splitStringByBackslash(value) ⇒ <code>Array.&lt;string&gt;</code>
Splits a string by the backslash character, trims each resulting substring, and filters out any empty strings.If the input value is falsy, it returns an empty array.

**Kind**: global function  
**Returns**: <code>Array.&lt;string&gt;</code> - An array of trimmed strings, e.g., ["Category 1", "Category 2"].  

| Param | Type | Description |
| --- | --- | --- |
| value | <code>string</code> \| <code>undefined</code> \| <code>null</code> | The string to split, e.g., "Category 1 \ Category 2". |

<a name="transformToBoolean"></a>

## transformToBoolean(value) ⇒ <code>boolean</code>
Transforms a value to its boolean equivalent. "1" or 1 becomes true, "0" or 0 becomes false.Any other value will result in false.

**Kind**: global function  
**Returns**: <code>boolean</code> - The boolean representation.  

| Param | Type | Description |
| --- | --- | --- |
| value | <code>string</code> \| <code>number</code> \| <code>undefined</code> \| <code>null</code> | The value to transform. |

<a name="getAllProducts"></a>

## getAllProducts() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Fetches all products from the database.

**Kind**: global function  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - A promise that resolves with an array of product documents.  
<a name="getProductByIdentifier"></a>

## getProductByIdentifier(identifier) ⇒ <code>Promise.&lt;(Object\|null)&gt;</code>
Fetches a single product from the database by its code or token.This function searches for the identifier in the main product's `code` and `token` fields,as well as in the `code` and `token` fields of any child products.

**Kind**: global function  
**Returns**: <code>Promise.&lt;(Object\|null)&gt;</code> - A promise that resolves with the product document or null if not found.  

| Param | Type | Description |
| --- | --- | --- |
| identifier | <code>string</code> | The code or token of the product to find. |

<a name="generateProductsTsv"></a>

## generateProductsTsv(exportId) ⇒ <code>Promise.&lt;string&gt;</code>
Generates a TSV string from the products data.

**Kind**: global function  
**Returns**: <code>Promise.&lt;string&gt;</code> - A promise that resolves with the TSV content.  

| Param | Type | Description |
| --- | --- | --- |
| exportId | <code>string</code> | The export identifier to get the category for (e.g., 'tris'). |

<a name="MongoDb"></a>

## MongoDb : <code>mongodb.Db</code>
**Kind**: global typedef  
