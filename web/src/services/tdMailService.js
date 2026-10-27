import { tdApiRequest } from './tdApiClient.js';

export const checkMailHealth = () => tdApiRequest('/mail/health');
export const sendMail = payload => tdApiRequest('/mail/send', { method: 'POST', body: payload });
export const sendSimpleMail = ({ to, subject, text } = {}) => sendMail({ to, subject, text });
