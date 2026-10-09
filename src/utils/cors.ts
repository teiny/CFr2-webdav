// 文件名：src/utils/cors.ts
export function setCORSHeaders(response: Response, request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }

  response.headers.set("Access-Control-Allow-Methods", "OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, COPY, MOVE, DELETE");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Depth, Overwrite, Destination, Range, If, If-Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since");
  response.headers.set("Access-Control-Expose-Headers", "Content-Type, Content-Length, DAV, Allow, ETag, Last-Modified, Location, Date, Content-Range, Accept-Ranges");
  response.headers.set("Access-Control-Allow-Credentials", "true");
  response.headers.set("Access-Control-Max-Age", "86400");
}
