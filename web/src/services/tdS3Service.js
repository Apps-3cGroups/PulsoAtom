import { tdApiRequest } from './tdApiClient.js';

export const uploadFileToS3 = payload => tdApiRequest('/s3/upload', { method: 'POST', body: payload });
export const getS3TemporaryUrl = ({ s3Key, expiresInSeconds } = {}) => tdApiRequest('/s3/url', { query: { s3Key, expiresInSeconds } });
export const downloadS3File = ({ s3Key } = {}) => tdApiRequest('/s3/download', { query: { s3Key }, responseType: 'blob' });
