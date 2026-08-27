export const getSessionKeyAuth = (sessionId: string) => {
  if (!sessionId)
    throw new Error('Session ID is required to generate cache key');
  return `auth:${sessionId}` as const;
};
export const getSessionKeyAuthAll = () => `auth:*` as const;
export const getSessionKeyAuthPrefix = () => `auth:` as const;
