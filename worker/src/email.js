const FROM = 'A/R <noreply@ar.gioxx.org>';

/**
 * Send a plain-text email through Resend. Never throws: a failure is logged and reported as false,
 * because callers (webhook, licence email) must succeed anyway.
 * @param {{to: string, subject: string, text: string}} msg
 */
export async function sendEmail(env, { to, subject, text }, { idempotencyKey } = {}) {
  try {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // Counted for the owner's dashboard (Resend's free plan is limited per day and per month).
    await env.DB?.prepare('INSERT INTO email_usage (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1')
      .bind(new Date().toISOString().slice(0, 10))
      .run()
      .catch((e) => console.error('email count failed', e));
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
    subject: slot ? 'A/R: il tuo codice per un posto in più / your extra seat code' : 'A/R: il tuo codice famiglia / your family code',
    text: [
      'Grazie per l\'acquisto!',
      '',
      slot ? `Il tuo codice per un posto in più: ${code}` : `Il tuo codice famiglia: ${code}`,
      '',
      slot
        ? 'Apri A/R su un telefono già in famiglia, vai in Menu → Famiglia → "Aggiungi un posto" e incolla lì il codice.'
        : 'Apri A/R, vai in Menu → Famiglia → "Ho già un codice" e incolla il codice.',
      'Il codice si può usare una sola volta.',
      '',
      slot
        ? 'IMPORTANTE: se non l\'hai ancora fatto, salva il kit di recupero della famiglia (Menu → Famiglia → Kit di recupero) in un posto sicuro, per esempio un password manager.'
        : 'IMPORTANTE: appena creata la famiglia, A/R ti mostra il kit di recupero. Salvalo subito in un posto sicuro, per esempio un password manager: se perdi tutti i telefoni è l\'unico modo per rientrare nella famiglia e ritrovare i dati, perché il codice non si può riusare.',
      'Come funziona il kit: https://ar.gioxx.org/guida/#kit',
      '',
      '---',
      '',
      'Thank you for your purchase!',
      '',
      slot ? `Your extra seat code: ${code}` : `Your family code: ${code}`,
      '',
      slot
        ? 'Open A/R on a phone already in the family, go to Menu → Family → "Add a seat" and paste the code there.'
        : 'Open A/R, go to Menu → Family → "I already have a code" and paste the code.',
      'The code can be used only once.',
      '',
      slot
        ? 'IMPORTANT: if you have not done it yet, save the family\'s recovery kit (Menu → Family → Recovery kit) somewhere safe, such as a password manager.'
        : 'IMPORTANT: right after creating the family, A/R shows you the recovery kit. Save it at once somewhere safe, such as a password manager: if you lose every phone it is the only way back into the family and its data, because the code cannot be used again.',
      'How the kit works: https://ar.gioxx.org/en/guide/#kit',
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
