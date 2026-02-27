# Lazy Hamster — API Notes

## Endpoints

### POST `/api/upload`
Upload a product image (multipart form-data, field `file`).
- Max size: 10 MB
- Accepted types: `image/*`
- Returns the S3 URL of the uploaded file.

### POST `/api/analyze`
Analyze a product image using OpenAI Vision.

**Request body:**
```json
{
  "imageUrl": "https://s3.amazonaws.com/...",
  "locale": "en"
}
```
- `imageUrl` (required) — public URL of the image (typically from `/api/upload`).
- `locale` (optional, default `"en"`) — language for the response.

**Response:**
```json
{
  "brand": "Apple",
  "model": "iPhone 15 Pro",
  "description": "A premium smartphone with titanium frame and A17 Pro chip."
}
```
