export function notFound(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.status || (error.name === "ValidationError" ? 400 : error.code === 11000 ? 409 : 500);
  const code = error.code === 11000 ? "DUPLICATE_VALUE" : status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR";
  const message = status === 500 ? "An unexpected server error occurred" : error.message;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: { code, message } });
}
