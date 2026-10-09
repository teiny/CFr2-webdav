import { Env } from '../types';
import { handleWebDAV } from './webdavHandler';
import { authenticate } from '../utils/auth';
import { setCORSHeaders } from '../utils/cors';
import { logger } from '../utils/logger';

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  let status = 500;
  try {
    if (request.method !== "OPTIONS" && !authenticate(request, env)) {
      status = 401;
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="WebDAV", charset="UTF-8"'
        }
      });
    }

    // 直接传递整个 env 对象给 handleWebDAV
    const response = await handleWebDAV(request, env);
    status = response.status;

    setCORSHeaders(response, request);
    return response;
  } catch (error) {
    logger.error("Error in request handling:", error);
    return new Response("Internal Server Error", { status: 500 });
  } finally {
    logger.info('Request completed', { method: request.method, status, handler_ms: Date.now() - started });
  }
}
