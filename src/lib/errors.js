export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const notFound = (code, message) => new AppError(404, code, message);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
export const unauthorized = (message = 'Требуется токен администратора') =>
  new AppError(401, 'unauthorized', message);
