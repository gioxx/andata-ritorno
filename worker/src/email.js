const FROM = 'A/R <noreply@ar.gioxx.org>';

/**
 * Send a plain-text email through Resend. Never throws: a failure is logged and reported as false,
 * because callers (webhook, licence email) must succeed anyway.
 * @param {{to: string, subject: string, text: string}} msg
 */
export async function sendEmail(env, { to, subject, text }) {
  try {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return true;
  } catch (e) {
    console.error('email send failed', e);
    return false;
  }
}

/** @param {string} code @param {'family'|'slot'} kind */
export function codeEmail(code, kind) {
  const slot = kind === 'slot';
  return {
    subject: slot ? 'A/R: il tuo codice posto extra / your extra slot code' : 'A/R: il tuo codice famiglia / your family code',
    text: [
      'Grazie per l\'acquisto!',
      '',
      slot ? `Il tuo codice posto extra: ${code}` : `Il tuo codice famiglia: ${code}`,
      '',
      slot
        ? 'Apri A/R su un dispositivo già in famiglia, vai in Menu → Famiglia e incolla il codice.'
        : 'Apri A/R, vai in Menu → Famiglia → "Ho già un codice" e incolla il codice.',
      'Il codice si può usare una sola volta.',
      '',
      '---',
      '',
      'Thank you for your purchase!',
      '',
      slot ? `Your extra slot code: ${code}` : `Your family code: ${code}`,
      '',
      slot
        ? 'Open A/R on a device already in the family, go to Menu → Family and paste the code.'
        : 'Open A/R, go to Menu → Family → "I already have a code" and paste the code.',
      'The code can be used only once.',
    ].join('\n'),
  };
}

/** @param {string[]} urls one link per licence registered to the address */
export function licenceLinkEmail(urls) {
  const list = urls.join('\n');
  return {
    subject: 'A/R: recupero licenza / licence recovery',
    text: [
      'Hai chiesto di recuperare la licenza di A/R. Apri questo link sul nuovo telefono entro 30 minuti:',
      '',
      list,
      '',
      'Il link avvia una nuova famiglia sulla stessa licenza: i dispositivi e i dati della famiglia precedente vengono eliminati.',
      'Se non sei stato tu, ignora questa email.',
      '',
      '---',
      '',
      'You asked to recover your A/R licence. Open this link on the new phone within 30 minutes:',
      '',
      list,
      '',
      'The link starts a new family on the same licence: the previous family\'s devices and data are deleted.',
      'If this wasn\'t you, ignore this email.',
    ].join('\n'),
  };
}
