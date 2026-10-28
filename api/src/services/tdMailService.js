import { tdApiClient } from './tdApiClient.js';

const fail = (message, code) => ({ success: false, message, data: null, error: { code } });

export function createTdMailService(client = tdApiClient) {
  const sendMail = async payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('Indica los datos del correo.', 'INVALID_MAIL');
    const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
    if (!recipients.length || recipients.some(to => typeof to !== 'string' || !to.trim())) return fail('El destinatario es obligatorio.', 'MISSING_RECIPIENT');
    if (typeof payload.subject !== 'string' || !payload.subject.trim()) return fail('El asunto es obligatorio.', 'MISSING_SUBJECT');
    if (!(typeof payload.text === 'string' && payload.text.trim()) && !(typeof payload.html === 'string' && payload.html.trim())) return fail('Indica text o html para el correo.', 'MISSING_MAIL_CONTENT');
    return client.request({ method: 'POST', path: '/mail/send', body: payload });
  };
  return {
    checkMailHealth: () => client.request({ path: '/mail/health' }),
    sendMail,
    sendSimpleMail: ({ to, subject, text } = {}) => sendMail({ to, subject, text }),
  };
}

export const { checkMailHealth, sendMail, sendSimpleMail } = createTdMailService();
