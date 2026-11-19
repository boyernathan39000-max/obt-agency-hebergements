/* ============================================================================
   PRISE DE RENDEZ-VOUS DU SITE, branchée sur l'agenda Google de l'agence.
   Programme Google Apps Script publié en « application Web » depuis le compte
   de l'agence (exécuté en tant que propriétaire, accessible à tous).

   GET  ?action=creneaux&debut=AAAA-MM-JJ&fin=AAAA-MM-JJ
        -> { creneaux: { "AAAA-MM-JJ": [ { heure: "09:00", debut: ISO } ] } }
   POST (corps JSON envoyé en text/plain pour éviter la requête préalable)
        -> { ok: true } ou { ok: false, erreur, code }

   Règles voulues par Nathan (18 novembre 2026) :
   - du lundi au samedi, de 9 h à 18 h 30, un rendez-vous de 30 minutes ;
   - jamais moins de 24 h à l'avance (à 15 h, rien avant 15 h le lendemain) ;
   - un créneau n'est proposé que si l'agenda est libre à ce moment-là.
   Aucune clé ni mot de passe ici : le programme agit avec le compte Google
   qui l'a publié.
   ========================================================================== */

var FUSEAU = 'Europe/Paris';
var AGENDA = 'primary';
var DUREE_MIN = 30;
var PAS_MIN = 30;
var PREMIERE_HEURE = 9 * 60;          // 9 h 00
var DERNIERE_HEURE = 18 * 60 + 30;    // 18 h 30, dernier début possible
var JOURS_OUVERTS = [1, 2, 3, 4, 5, 6]; // lundi (1) à samedi (6)
var DELAI_MIN_MS = 24 * 60 * 60 * 1000;
var HORIZON_JOURS = 92;
var DATE_SEULE = /^\d{4}-\d{2}-\d{2}$/;

function json_(objet) {
  return ContentService.createTextOutput(JSON.stringify(objet))
    .setMimeType(ContentService.MimeType.JSON);
}

function texte_(v, max) {
  return (typeof v === 'string' ? v : '').trim().slice(0, max);
}

/* Minuit à Paris pour une date AAAA-MM-JJ. */
function minuit_(jour) {
  return Utilities.parseDate(jour + ' 00:00', FUSEAU, 'yyyy-MM-dd HH:mm');
}

function iso_(d) {
  return Utilities.formatDate(d, FUSEAU, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function occupations_(debut, fin) {
  var r = Calendar.Freebusy.query({
    timeMin: debut.toISOString(),
    timeMax: fin.toISOString(),
    timeZone: FUSEAU,
    items: [{ id: AGENDA }]
  });
  var cal = (r.calendars && (r.calendars[AGENDA] || r.calendars[Object.keys(r.calendars)[0]])) || {};
  return (cal.busy || []).map(function (b) {
    return { debut: new Date(b.start).getTime(), fin: new Date(b.end).getTime() };
  });
}

function libre_(debutMs, occupe) {
  var finMs = debutMs + DUREE_MIN * 60000;
  for (var i = 0; i < occupe.length; i++) {
    if (debutMs < occupe[i].fin && finMs > occupe[i].debut) return false;
  }
  return true;
}

/* Un début valable : bon jour de semaine, bonne heure, sur la grille des
   demi-heures et au moins 24 h après maintenant. */
function debutValable_(d) {
  var jourSemaine = Number(Utilities.formatDate(d, FUSEAU, 'u'));
  var h = Number(Utilities.formatDate(d, FUSEAU, 'H'));
  var m = Number(Utilities.formatDate(d, FUSEAU, 'm'));
  var minutes = h * 60 + m;
  if (JOURS_OUVERTS.indexOf(jourSemaine) < 0) return false;
  if (minutes < PREMIERE_HEURE || minutes > DERNIERE_HEURE) return false;
  if ((minutes - PREMIERE_HEURE) % PAS_MIN !== 0 || d.getSeconds() !== 0) return false;
  return d.getTime() >= Date.now() + DELAI_MIN_MS;
}

function creneaux_(debutTxt, finTxt) {
  if (!DATE_SEULE.test(debutTxt || '') || !DATE_SEULE.test(finTxt || '')) {
    return { erreur: 'Dates attendues au format AAAA-MM-JJ.' };
  }
  var debut = minuit_(debutTxt);
  var fin = new Date(minuit_(finTxt).getTime() + 24 * 3600 * 1000);
  var limite = Date.now() + HORIZON_JOURS * 24 * 3600 * 1000;
  if (fin.getTime() > limite) fin = new Date(limite);
  if (fin <= debut) return { creneaux: {}, fuseau: FUSEAU };

  var occupe = occupations_(debut, fin);
  var sortie = {};
  for (var j = new Date(debut); j < fin; j = new Date(j.getTime() + 26 * 3600 * 1000)) {
    var jour = Utilities.formatDate(j, FUSEAU, 'yyyy-MM-dd');
    j = minuit_(jour);
    if (sortie[jour]) continue;
    var liste = [];
    for (var min = PREMIERE_HEURE; min <= DERNIERE_HEURE; min += PAS_MIN) {
      var heure = ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2);
      var d = Utilities.parseDate(jour + ' ' + heure, FUSEAU, 'yyyy-MM-dd HH:mm');
      if (!debutValable_(d)) continue;
      if (!libre_(d.getTime(), occupe)) continue;
      liste.push({ heure: heure, debut: iso_(d) });
    }
    if (liste.length) sortie[jour] = liste;
  }
  return { creneaux: sortie, fuseau: FUSEAU };
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'creneaux') return json_(creneaux_(p.debut, p.fin));
    return json_({ ok: true, service: 'rendez-vous OBT Agency' });
  } catch (err) {
    return json_({ erreur: "L'agenda ne répond pas." });
  }
}

var COURRIEL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function doPost(e) {
  var d;
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, erreur: 'Demande illisible.' }); }

  /* Champ-piège : un robot remplit tout. On répond « ok » sans rien créer. */
  if (texte_(d.botcheck, 10)) return json_({ ok: true });

  var nom = texte_(d.nom, 120);
  var email = texte_(d.email, 160);
  var tel = texte_(d.tel, 40);
  var entreprise = texte_(d.entreprise, 160);
  var site = texte_(d.site, 300);
  var fiche = texte_(d.fiche, 300);
  var besoin = texte_(d.besoin, 120);
  var message = texte_(d.message, 2000);
  var debut = new Date(texte_(d.debut, 40));

  /* 19/11/2026 : le site ne demande plus l'entreprise, seulement le prénom. */
  if (!entreprise) entreprise = site || fiche || nom;
  if (!nom || !tel) return json_({ ok: false, erreur: 'Il manque des informations.' });
  if (!COURRIEL.test(email)) return json_({ ok: false, erreur: 'Adresse e-mail invalide.' });
  if (isNaN(debut.getTime()) || !debutValable_(debut)) {
    return json_({ ok: false, code: 'pris', erreur: 'Ce créneau n’est plus disponible.' });
  }

  var verrou = LockService.getScriptLock();
  try { verrou.waitLock(20000); }
  catch (err) { return json_({ ok: false, erreur: "L'agenda est occupé, réessayez." }); }

  try {
    var fin = new Date(debut.getTime() + DUREE_MIN * 60000);
    if (!libre_(debut.getTime(), occupations_(debut, fin))) {
      return json_({ ok: false, code: 'pris', erreur: 'Ce créneau vient d’être pris.' });
    }

    var notes = [
      'Rendez-vous maquette pris depuis le site, par téléphone : OBT Agency appelle le client.',
      '',
      'Prénom : ' + nom,
      'Entreprise : ' + entreprise,
      'Téléphone : ' + tel,
      'E-mail : ' + email,
      'Besoin : ' + (besoin || 'non précisé'),
      'Site : ' + (site || 'non indiqué'),
      'Fiche Google : ' + (fiche || 'non indiquée'),
      message ? 'Message : ' + message : ''
    ].filter(function (l, i) { return l !== '' || i === 1; }).join('\n');

    /* L'événement reste dans NOTRE agenda, sans invité : l'invitation
       Google partait en anglais chez les clients hors Gmail, avec des
       boutons inutiles (plan, liste des invités) et une réponse « Oui » qui
       menait à « événement introuvable ». Le client reçoit à la place notre
       propre e-mail, en français, avec un fichier d'agenda joint
       (Nathan, 19 novembre 2026). */
    var evenement = Calendar.Events.insert({
      summary: 'Rendez-vous maquette OBT Agency : ' + entreprise,
      description: notes,
      start: { dateTime: debut.toISOString(), timeZone: FUSEAU },
      end: { dateTime: fin.toISOString(), timeZone: FUSEAU },
      location: 'Par téléphone : OBT Agency appelle le ' + tel
    }, AGENDA, { sendUpdates: 'none' });

    /* La date en français : formatDate écrit les jours et les mois en anglais. */
    var JOURS_FR = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
    var MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
      'septembre', 'octobre', 'novembre', 'décembre'];
    var jourTxt = JOURS_FR[Number(Utilities.formatDate(debut, FUSEAU, 'u'))] + ' ' +
      Number(Utilities.formatDate(debut, FUSEAU, 'd')) + ' ' +
      MOIS_FR[Number(Utilities.formatDate(debut, FUSEAU, 'M')) - 1];
    var mn = Utilities.formatDate(debut, FUSEAU, 'mm');
    var heureTxt = Number(Utilities.formatDate(debut, FUSEAU, 'H')) + ' h' + (mn === '00' ? '' : ' ' + mn);
    var quand = jourTxt + ' ' + Utilities.formatDate(debut, FUSEAU, 'yyyy') + ' à ' + heureTxt;

    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      replyTo: email,
      subject: 'Nouveau rendez-vous maquette : ' + entreprise,
      body: notes + '\n\nQuand : ' + quand + ' (heure de Paris)\nÀ appeler au : ' + tel +
        '\nÉvénement : ' + (evenement.htmlLink || '')
    });

    envoieConfirmation_(email, nom, tel, jourTxt, heureTxt, debut, fin);

    return json_({ ok: true, reference: evenement.id });
  } catch (err) {
    return json_({ ok: false, erreur: "La réservation n'a pas abouti." });
  } finally {
    verrou.releaseLock();
  }
}


/* ---------------------------------------------------------------------------
   L'e-mail de confirmation envoyé au client (Nathan, 19 novembre 2026).
   Tout en français, au vous, signé « Tom ou Nathan », sans bloc de
   signature (demande de Nathan).
   Un fichier .ics est joint : la boîte du client
   propose « Ajouter à l'agenda », sans réponse Oui/Non à donner.
   ------------------------------------------------------------------------ */
function echappe_(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ics_(debut, fin, tel) {
  var z = function (d) { return Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'"); };
  var lignes = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OBT Agency//Rendez-vous//FR',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + Utilities.getUuid() + '@obt-agency.fr',
    'DTSTAMP:' + z(new Date()),
    'DTSTART:' + z(debut),
    'DTEND:' + z(fin),
    'SUMMARY:Rendez-vous de maquette avec OBT Agency',
    'DESCRIPTION:Tom ou Nathan vous appelle au ' + tel + '. Rendez-vous de 30 minutes.',
    'LOCATION:Par téléphone',
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return Utilities.newBlob(lignes.join('\r\n'), 'text/calendar', 'rendez-vous-obt-agency.ics');
}

function envoieConfirmation_(email, prenom, tel, jourTxt, heureTxt, debut, fin) {
  var P = 'margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#12151A;';
  var html = ''
    + '<div style="max-width:560px">'
    + '<p style="' + P + '">Bonjour ' + echappe_(prenom) + ',</p>'
    + '<p style="' + P + '">Votre rendez-vous de maquette est confirmé&nbsp;:</p>'
    + '<p style="' + P + 'font-size:18px;font-weight:bold;">' + echappe_(jourTxt.charAt(0).toUpperCase() + jourTxt.slice(1)) + ' à ' + echappe_(heureTxt) + '</p>'
    + '<p style="' + P + '">Tom ou Nathan vous appelle au ' + echappe_(tel) + ' à l’heure prévue. Le rendez-vous dure 30&nbsp;minutes.</p>'
    + '<p style="' + P + '">Nous commençons la construction de votre maquette.</p>'
    + '<p style="' + P + '">Pour ajouter le rendez-vous à votre agenda, ouvrez le fichier joint. Pour changer d’horaire, répondez simplement à ce mail.</p>'
    + '<p style="' + P + '">Bien cordialement,<br>Tom ou Nathan</p>'
    + '</div>';
  var texte = 'Bonjour ' + prenom + ',\n\n'
    + 'Votre rendez-vous de maquette est confirmé : ' + jourTxt + ' à ' + heureTxt + '.\n\n'
    + 'Tom ou Nathan vous appelle au ' + tel + ' à l’heure prévue. Le rendez-vous dure 30 minutes.\n\n'
    + 'Nous commençons la construction de votre maquette.\n\n'
    + 'Pour ajouter le rendez-vous à votre agenda, ouvrez le fichier joint. Pour changer d’horaire, répondez simplement à ce mail.\n\n'
    + 'Bien cordialement,\nTom ou Nathan';
  MailApp.sendEmail({
    to: email,
    subject: 'Confirmation de votre rendez-vous de maquette avec OBT Agency',
    name: 'OBT Agency',
    body: texte,
    htmlBody: html,
    attachments: [ics_(debut, fin, tel)]
  });
}
