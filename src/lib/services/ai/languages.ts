/**
 * The follow-up scaffolding, in every outreach language.
 *
 * This is the ENTIRE translation layer of the application, and it is static
 * on purpose. The operator's requirement was that translation be done by the
 * website's own code and not by a model; Ollama lives on their machine and is
 * not reachable from Vercel. So each language here is a hand-written set of
 * the same dozen sentences the English template generator has always used —
 * deterministic, offline, no runtime dependency, and reviewable by a native
 * speaker as plain text.
 *
 * What is NOT here: any per-lead prose. The one line of that a follow-up
 * quotes (the "angle") is written natively by n8n alongside the initial and
 * stored on the version row; `bestAngle()` prefers it. When it is absent the
 * English research is quoted instead, which is the honest fallback — a mixed
 * sentence beats a missing one.
 *
 * Register: formal "you" wherever the language distinguishes it (Sie, vous,
 * usted, Lei, u, Ön, Pan/Pani, Вие, Siz). Business names and "Team
 * Automation" are never translated; they arrive through `{{signature}}` and
 * the `name` argument untouched. Both `{{angle}}` and `{{signature}}` must
 * appear verbatim in every language — the generator substitutes them.
 *
 * Quality note, stated plainly: the European languages here are ones I can
 * vouch for. Arabic, Japanese, Turkish, Indonesian and Malay are correct
 * formal business register to the best of my ability, but should get a
 * native-speaker read before real volume — the operator cannot check them.
 */

export type LanguageCode =
  | 'en' | 'de' | 'nl' | 'fr' | 'it' | 'es' | 'pt' | 'no' | 'da' | 'sv'
  | 'pl' | 'cs' | 'hu' | 'el' | 'bg' | 'tr' | 'ja' | 'id' | 'ms' | 'ar';

export const LANGUAGE_CODES: readonly LanguageCode[] = [
  'en', 'de', 'nl', 'fr', 'it', 'es', 'pt', 'no', 'da', 'sv',
  'pl', 'cs', 'hu', 'el', 'bg', 'tr', 'ja', 'id', 'ms', 'ar',
];

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (LANGUAGE_CODES as readonly string[]).includes(value);
}

/** Every sentence the template generator composes from. */
export interface LanguagePack {
  /** Human name, for provenance and the Settings screen. */
  name: string;

  initialSubject: (name: string) => string;
  /** `where` is "City, Country" or empty. */
  initialOpener: (name: string, where: string) => string;
  /** Used when the lead has no research summary. `niche` may be empty. */
  initialFallbackIntro: (niche: string) => string;
  askInitial: (name: string) => string;

  followup1Subject: (name: string) => string;
  followup1Opener: (name: string) => string;
  askFollowup1: (name: string) => string;

  followup2Subject: (name: string) => string;
  followup2Opener: (name: string) => string;
  /** Must contain the literal token {{angle}}. */
  followup2Note: string;
  followup2Close: string;

  /** Quoted when no usable research sentence exists at all. */
  angleFallback: string;
  /** Stands in for the niche when it is blank: "businesses like yours". */
  genericNiche: string;
}

export const LANGUAGES: Record<LanguageCode, LanguagePack> = {
  en: {
    name: 'English',
    initialSubject: (name) => `Quick idea for ${name}`,
    initialOpener: (name, where) => `Hi, I came across ${name}${where ? ` in ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `I work with ${niche || 'businesses like yours'} on automating the repetitive parts of their day.`,
    askInitial: (name) =>
      `But rather than guess, I would rather just ask: what is one problem you wish technology could take off your plate at ${name}? I help local businesses fix exactly that kind of thing. Tell me what is bugging you and I will tell you honestly whether I can help.`,
    followup1Subject: (name) => `Following up ${name}`,
    followup1Opener: (name) =>
      `I wrote last week about ${name} and never heard back. No problem, inboxes are inboxes.`,
    askFollowup1: (name) =>
      `Genuine question, no pitch attached: what is one problem you wish technology could just solve for you at ${name}? I work with local businesses on exactly that. Reply with what it is and I will tell you straight whether I can help.`,
    followup2Subject: (name) => `Closing the loop on ${name}`,
    followup2Opener: (name) => `Last one from me about ${name}.`,
    followup2Note: 'For what it is worth, here is the note I made when I looked you up: {{angle}}',
    followup2Close:
      'If the timing is simply wrong, no reply needed and I will close the file. If that changes later, reply to this and I will pick it back up.',
    angleFallback:
      'The specific thing I had in mind was cutting the manual admin work around enquiries and follow-up.',
    genericNiche: 'businesses like yours',
  },

  de: {
    name: 'German',
    initialSubject: (name) => `Kurze Idee für ${name}`,
    initialOpener: (name, where) =>
      `Guten Tag, ich bin auf ${name}${where ? ` in ${where}` : ''} aufmerksam geworden.`,
    initialFallbackIntro: (niche) =>
      `Ich arbeite mit ${niche || 'Unternehmen wie Ihrem'} daran, die sich wiederholenden Aufgaben des Alltags zu automatisieren.`,
    askInitial: (name) =>
      `Statt zu raten, frage ich lieber direkt: Welches Problem bei ${name} würden Sie sich am liebsten von der Technik abnehmen lassen? Genau solche Dinge löse ich für lokale Unternehmen. Schreiben Sie mir, was Sie stört, und ich sage Ihnen ehrlich, ob ich helfen kann.`,
    followup1Subject: (name) => `Nachfrage zu ${name}`,
    followup1Opener: (name) =>
      `Ich hatte Ihnen letzte Woche wegen ${name} geschrieben und nichts gehört. Kein Problem, Postfächer sind eben Postfächer.`,
    askFollowup1: (name) =>
      `Eine ehrliche Frage, ohne Verkaufsabsicht: Welches Problem bei ${name} sollte die Technik einfach für Sie lösen? Genau daran arbeite ich mit lokalen Unternehmen. Antworten Sie mir kurz, worum es geht, und ich sage Ihnen offen, ob ich helfen kann.`,
    followup2Subject: (name) => `Letzte Nachricht zu ${name}`,
    followup2Opener: (name) => `Meine letzte Nachricht zu ${name}.`,
    followup2Note:
      'Der Vollständigkeit halber, hier die Notiz, die ich mir beim Nachschauen gemacht habe: {{angle}}',
    followup2Close:
      'Wenn der Zeitpunkt einfach nicht passt, ist keine Antwort nötig und ich schließe das Thema. Sollte sich das später ändern, antworten Sie einfach auf diese Nachricht und ich nehme den Faden wieder auf.',
    angleFallback:
      'Konkret hatte ich im Sinn, den manuellen Verwaltungsaufwand rund um Anfragen und Nachfassen zu reduzieren.',
    genericNiche: 'Unternehmen wie Ihrem',
  },

  nl: {
    name: 'Dutch',
    initialSubject: (name) => `Kort idee voor ${name}`,
    initialOpener: (name, where) => `Goedendag, ik kwam ${name}${where ? ` in ${where}` : ''} tegen.`,
    initialFallbackIntro: (niche) =>
      `Ik help ${niche || 'bedrijven zoals het uwe'} met het automatiseren van de terugkerende taken van de dag.`,
    askInitial: (name) =>
      `In plaats van te gissen vraag ik het liever direct: welk probleem bij ${name} zou u het liefst door technologie laten oplossen? Precies dat soort dingen los ik op voor lokale bedrijven. Laat me weten wat u dwarszit en ik zeg u eerlijk of ik kan helpen.`,
    followup1Subject: (name) => `Even opvolgen: ${name}`,
    followup1Opener: (name) =>
      `Ik schreef u vorige week over ${name} en heb niets gehoord. Geen probleem, een inbox is een inbox.`,
    askFollowup1: (name) =>
      `Een oprechte vraag, zonder verkooppraatje: welk probleem bij ${name} zou technologie gewoon voor u moeten oplossen? Daar werk ik precies aan met lokale bedrijven. Antwoord met wat het is en ik zeg u recht voor zijn raap of ik kan helpen.`,
    followup2Subject: (name) => `Laatste bericht over ${name}`,
    followup2Opener: (name) => `Mijn laatste bericht over ${name}.`,
    followup2Note: 'Voor wat het waard is, dit is de notitie die ik maakte toen ik u opzocht: {{angle}}',
    followup2Close:
      'Als het moment simpelweg niet goed is, hoeft u niet te reageren en sluit ik het dossier. Verandert dat later, antwoord dan op dit bericht en ik pak het weer op.',
    angleFallback:
      'Wat ik concreet in gedachten had, is het schrappen van het handmatige administratieve werk rond aanvragen en opvolging.',
    genericNiche: 'bedrijven zoals het uwe',
  },

  fr: {
    name: 'French',
    initialSubject: (name) => `Une idée rapide pour ${name}`,
    initialOpener: (name, where) => `Bonjour, je suis tombé sur ${name}${where ? ` à ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `J'accompagne ${niche || 'des entreprises comme la vôtre'} pour automatiser les tâches répétitives du quotidien.`,
    askInitial: (name) =>
      `Plutôt que de deviner, je préfère vous poser la question directement : quel problème chez ${name} aimeriez-vous voir pris en charge par la technologie ? C'est exactement ce que je règle pour des entreprises locales. Dites-moi ce qui vous pèse et je vous dirai honnêtement si je peux aider.`,
    followup1Subject: (name) => `Relance au sujet de ${name}`,
    followup1Opener: (name) =>
      `Je vous ai écrit la semaine dernière au sujet de ${name} sans avoir de retour. Aucun souci, les boîtes mail sont ce qu'elles sont.`,
    askFollowup1: (name) =>
      `Une vraie question, sans argumentaire : quel problème chez ${name} la technologie devrait-elle tout simplement résoudre pour vous ? C'est précisément mon travail avec des entreprises locales. Répondez-moi en quelques mots et je vous dirai franchement si je peux aider.`,
    followup2Subject: (name) => `Dernier message concernant ${name}`,
    followup2Opener: (name) => `Mon dernier message concernant ${name}.`,
    followup2Note: "Pour ce que ça vaut, voici la note que j'avais prise en me renseignant sur vous : {{angle}}",
    followup2Close:
      "Si le moment n'est simplement pas le bon, inutile de répondre, je clos le dossier. Si cela change plus tard, répondez à ce message et je reprendrai le fil.",
    angleFallback:
      "Ce que j'avais précisément en tête, c'est de réduire le travail administratif manuel autour des demandes et des relances.",
    genericNiche: 'des entreprises comme la vôtre',
  },

  it: {
    name: 'Italian',
    initialSubject: (name) => `Un'idea veloce per ${name}`,
    initialOpener: (name, where) => `Buongiorno, mi sono imbattuto in ${name}${where ? ` a ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Lavoro con ${niche || 'aziende come la vostra'} per automatizzare le attività ripetitive della giornata.`,
    askInitial: (name) =>
      `Piuttosto che tirare a indovinare, preferisco chiederlo direttamente: qual è il problema che, da ${name}, vorreste che la tecnologia vi togliesse di mano? È esattamente ciò che risolvo per le aziende locali. Ditemi cosa vi pesa e vi dirò con sincerità se posso aiutarvi.`,
    followup1Subject: (name) => `Un seguito su ${name}`,
    followup1Opener: (name) =>
      `Vi ho scritto la settimana scorsa a proposito di ${name} senza ricevere risposta. Nessun problema, le caselle di posta sono quello che sono.`,
    askFollowup1: (name) =>
      `Una domanda sincera, senza alcuna proposta commerciale: qual è il problema che, da ${name}, la tecnologia dovrebbe semplicemente risolvere per voi? È proprio di questo che mi occupo con le aziende locali. Rispondetemi in due parole e vi dirò schiettamente se posso aiutarvi.`,
    followup2Subject: (name) => `Ultimo messaggio su ${name}`,
    followup2Opener: (name) => `L'ultimo messaggio da parte mia su ${name}.`,
    followup2Note: 'Per quel che vale, ecco l\'appunto che avevo preso quando vi ho cercato: {{angle}}',
    followup2Close:
      'Se semplicemente non è il momento giusto, non serve rispondere e chiudo la pratica. Se in seguito le cose dovessero cambiare, rispondete a questo messaggio e riprenderò il discorso.',
    angleFallback:
      'Ciò che avevo in mente nello specifico è ridurre il lavoro amministrativo manuale legato alle richieste e ai follow-up.',
    genericNiche: 'aziende come la vostra',
  },

  es: {
    name: 'Spanish',
    initialSubject: (name) => `Una idea rápida para ${name}`,
    initialOpener: (name, where) => `Hola, me encontré con ${name}${where ? ` en ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Trabajo con ${niche || 'empresas como la suya'} para automatizar las tareas repetitivas del día a día.`,
    askInitial: (name) =>
      `En lugar de adivinar, prefiero preguntarlo directamente: ¿qué problema en ${name} le gustaría que la tecnología le quitara de encima? Es exactamente lo que resuelvo para empresas locales. Cuénteme qué le molesta y le diré con sinceridad si puedo ayudar.`,
    followup1Subject: (name) => `Seguimiento sobre ${name}`,
    followup1Opener: (name) =>
      `Le escribí la semana pasada sobre ${name} y no obtuve respuesta. No pasa nada, las bandejas de entrada son lo que son.`,
    askFollowup1: (name) =>
      `Una pregunta sincera, sin ningún discurso de venta: ¿qué problema en ${name} debería resolverle la tecnología sin más? A eso me dedico precisamente con empresas locales. Respóndame con lo que sea y le diré sin rodeos si puedo ayudar.`,
    followup2Subject: (name) => `Último mensaje sobre ${name}`,
    followup2Opener: (name) => `Mi último mensaje sobre ${name}.`,
    followup2Note: 'Por si sirve de algo, esta es la nota que tomé cuando busqué información sobre ustedes: {{angle}}',
    followup2Close:
      'Si simplemente no es el momento, no hace falta responder y cierro el expediente. Si eso cambia más adelante, responda a este mensaje y retomo la conversación.',
    angleFallback:
      'Lo que tenía en mente concretamente es reducir el trabajo administrativo manual en torno a las consultas y el seguimiento.',
    genericNiche: 'empresas como la suya',
  },

  pt: {
    name: 'Portuguese',
    initialSubject: (name) => `Uma ideia rápida para ${name}`,
    initialOpener: (name, where) => `Olá, encontrei a ${name}${where ? ` em ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Trabalho com ${niche || 'empresas como a sua'} na automação das tarefas repetitivas do dia a dia.`,
    askInitial: (name) =>
      `Em vez de adivinhar, prefiro perguntar diretamente: qual é o problema na ${name} que gostaria que a tecnologia resolvesse por si? É exatamente esse tipo de coisa que resolvo para empresas locais. Diga-me o que o incomoda e direi com toda a honestidade se posso ajudar.`,
    followup1Subject: (name) => `Seguimento sobre a ${name}`,
    followup1Opener: (name) =>
      `Escrevi-lhe na semana passada sobre a ${name} e não obtive resposta. Sem problema, caixas de entrada são caixas de entrada.`,
    askFollowup1: (name) =>
      `Uma pergunta genuína, sem qualquer discurso de vendas: qual é o problema na ${name} que a tecnologia deveria simplesmente resolver por si? É precisamente nisso que trabalho com empresas locais. Responda com o que for e direi sem rodeios se posso ajudar.`,
    followup2Subject: (name) => `Última mensagem sobre a ${name}`,
    followup2Opener: (name) => `A minha última mensagem sobre a ${name}.`,
    followup2Note: 'Para o que vale, aqui está a nota que fiz quando pesquisei sobre vocês: {{angle}}',
    followup2Close:
      'Se o momento simplesmente não for o certo, não precisa de responder e encerro o assunto. Se isso mudar mais tarde, responda a esta mensagem e retomo a conversa.',
    angleFallback:
      'O que tinha especificamente em mente era reduzir o trabalho administrativo manual em torno dos pedidos de informação e do seguimento.',
    genericNiche: 'empresas como a sua',
  },

  no: {
    name: 'Norwegian',
    initialSubject: (name) => `En rask idé til ${name}`,
    initialOpener: (name, where) => `Hei, jeg kom over ${name}${where ? ` i ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Jeg jobber med ${niche || 'bedrifter som deres'} for å automatisere de repeterende oppgavene i hverdagen.`,
    askInitial: (name) =>
      `I stedet for å gjette vil jeg heller spørre rett ut: hvilket problem hos ${name} skulle dere ønske teknologien kunne ta av hendene deres? Det er nøyaktig slike ting jeg løser for lokale bedrifter. Fortell meg hva som plager dere, så sier jeg ærlig om jeg kan hjelpe.`,
    followup1Subject: (name) => `Oppfølging om ${name}`,
    followup1Opener: (name) =>
      `Jeg skrev til dere forrige uke om ${name} uten å høre noe. Helt greit, innbokser er innbokser.`,
    askFollowup1: (name) =>
      `Et ærlig spørsmål, uten noe salgspitch: hvilket problem hos ${name} burde teknologien rett og slett løse for dere? Det er akkurat det jeg jobber med for lokale bedrifter. Svar med hva det er, så sier jeg rett ut om jeg kan hjelpe.`,
    followup2Subject: (name) => `Siste melding om ${name}`,
    followup2Opener: (name) => `Min siste melding om ${name}.`,
    followup2Note: 'For hva det er verdt, her er notatet jeg gjorde da jeg slo dere opp: {{angle}}',
    followup2Close:
      'Hvis tidspunktet rett og slett er feil, trenger dere ikke svare, så avslutter jeg saken. Endrer det seg senere, svar på denne meldingen, så tar jeg tråden opp igjen.',
    angleFallback:
      'Det jeg konkret hadde i tankene var å kutte det manuelle administrasjonsarbeidet rundt henvendelser og oppfølging.',
    genericNiche: 'bedrifter som deres',
  },

  da: {
    name: 'Danish',
    initialSubject: (name) => `En hurtig idé til ${name}`,
    initialOpener: (name, where) => `Hej, jeg faldt over ${name}${where ? ` i ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Jeg arbejder med ${niche || 'virksomheder som jeres'} om at automatisere de gentagne opgaver i hverdagen.`,
    askInitial: (name) =>
      `I stedet for at gætte vil jeg hellere spørge direkte: hvilket problem hos ${name} ville I ønske, teknologien kunne tage fra jer? Det er præcis den slags, jeg løser for lokale virksomheder. Fortæl mig, hvad der generer jer, så siger jeg ærligt, om jeg kan hjælpe.`,
    followup1Subject: (name) => `Opfølgning på ${name}`,
    followup1Opener: (name) =>
      `Jeg skrev til jer i sidste uge om ${name} og hørte ikke noget. Helt i orden, indbakker er indbakker.`,
    askFollowup1: (name) =>
      `Et ærligt spørgsmål uden salgstale: hvilket problem hos ${name} burde teknologien bare løse for jer? Det er lige det, jeg arbejder med for lokale virksomheder. Svar med, hvad det er, så siger jeg ligeud, om jeg kan hjælpe.`,
    followup2Subject: (name) => `Sidste besked om ${name}`,
    followup2Opener: (name) => `Min sidste besked om ${name}.`,
    followup2Note: 'For hvad det er værd, her er den note, jeg lavede, da jeg slog jer op: {{angle}}',
    followup2Close:
      'Hvis timingen simpelthen er forkert, behøver I ikke svare, så lukker jeg sagen. Ændrer det sig senere, så svar på denne besked, og jeg tager tråden op igen.',
    angleFallback:
      'Det, jeg konkret havde i tankerne, var at skære det manuelle administrative arbejde omkring henvendelser og opfølgning væk.',
    genericNiche: 'virksomheder som jeres',
  },

  sv: {
    name: 'Swedish',
    initialSubject: (name) => `En snabb idé till ${name}`,
    initialOpener: (name, where) => `Hej, jag stötte på ${name}${where ? ` i ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Jag arbetar med ${niche || 'företag som ert'} för att automatisera de återkommande uppgifterna i vardagen.`,
    askInitial: (name) =>
      `Hellre än att gissa vill jag fråga rakt ut: vilket problem hos ${name} skulle ni önska att tekniken kunde ta hand om åt er? Det är precis sådant jag löser för lokala företag. Berätta vad som stör er, så säger jag ärligt om jag kan hjälpa till.`,
    followup1Subject: (name) => `Uppföljning om ${name}`,
    followup1Opener: (name) =>
      `Jag skrev till er förra veckan om ${name} utan att höra något. Inga problem, inkorgar är inkorgar.`,
    askFollowup1: (name) =>
      `En uppriktig fråga, utan säljsnack: vilket problem hos ${name} borde tekniken helt enkelt lösa åt er? Det är exakt det jag jobbar med för lokala företag. Svara med vad det är, så säger jag rakt ut om jag kan hjälpa till.`,
    followup2Subject: (name) => `Sista meddelandet om ${name}`,
    followup2Opener: (name) => `Mitt sista meddelande om ${name}.`,
    followup2Note: 'För vad det är värt, här är anteckningen jag gjorde när jag slog upp er: {{angle}}',
    followup2Close:
      'Om tidpunkten helt enkelt är fel behöver ni inte svara, så avslutar jag ärendet. Ändras det längre fram, svara på det här meddelandet så tar jag upp tråden igen.',
    angleFallback:
      'Det jag konkret hade i åtanke var att skära bort det manuella administrativa arbetet kring förfrågningar och uppföljning.',
    genericNiche: 'företag som ert',
  },

  pl: {
    name: 'Polish',
    initialSubject: (name) => `Krótki pomysł dla ${name}`,
    initialOpener: (name, where) => `Dzień dobry, natknąłem się na ${name}${where ? ` w ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Pomagam ${niche || 'firmom takim jak Państwa'} automatyzować powtarzalne czynności dnia codziennego.`,
    askInitial: (name) =>
      `Zamiast zgadywać, wolę zapytać wprost: jaki problem w ${name} chcieliby Państwo, aby technologia zdjęła Państwu z głowy? Dokładnie takie rzeczy rozwiązuję dla lokalnych firm. Proszę napisać, co Państwu doskwiera, a szczerze powiem, czy mogę pomóc.`,
    followup1Subject: (name) => `W nawiązaniu: ${name}`,
    followup1Opener: (name) =>
      `Pisałem w zeszłym tygodniu w sprawie ${name} i nie otrzymałem odpowiedzi. Nic nie szkodzi, skrzynki odbiorcze rządzą się swoimi prawami.`,
    askFollowup1: (name) =>
      `Szczere pytanie, bez żadnej oferty: jaki problem w ${name} technologia powinna po prostu za Państwa rozwiązać? Właśnie tym zajmuję się z lokalnymi firmami. Proszę odpisać, o co chodzi, a powiem wprost, czy mogę pomóc.`,
    followup2Subject: (name) => `Ostatnia wiadomość w sprawie ${name}`,
    followup2Opener: (name) => `Moja ostatnia wiadomość w sprawie ${name}.`,
    followup2Note: 'Na wszelki wypadek, oto notatka, którą zrobiłem, gdy Państwa sprawdzałem: {{angle}}',
    followup2Close:
      'Jeśli to po prostu nie jest dobry moment, odpowiedź nie jest potrzebna i zamykam temat. Gdyby to się później zmieniło, proszę odpowiedzieć na tę wiadomość, a podejmę wątek na nowo.',
    angleFallback:
      'Konkretnie miałem na myśli ograniczenie ręcznej pracy administracyjnej związanej z zapytaniami i ich obsługą.',
    genericNiche: 'firmom takim jak Państwa',
  },

  cs: {
    name: 'Czech',
    initialSubject: (name) => `Rychlý nápad pro ${name}`,
    initialOpener: (name, where) => `Dobrý den, narazil jsem na ${name}${where ? ` v ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Pomáhám ${niche || 'firmám, jako je ta vaše'} automatizovat opakující se činnosti každodenního provozu.`,
    askInitial: (name) =>
      `Než abych hádal, raději se zeptám přímo: jaký problém v ${name} byste si přáli, aby za vás vyřešila technologie? Přesně takové věci řeším pro místní firmy. Napište mi, co vás trápí, a upřímně vám řeknu, jestli mohu pomoci.`,
    followup1Subject: (name) => `Navazuji: ${name}`,
    followup1Opener: (name) =>
      `Psal jsem vám minulý týden ohledně ${name} a nedostal jsem odpověď. Nic se neděje, schránky jsou prostě schránky.`,
    askFollowup1: (name) =>
      `Upřímná otázka, bez jakékoli nabídky: jaký problém v ${name} by za vás technologie měla prostě vyřešit? Přesně na tom pracuji s místními firmami. Odpovězte, o co jde, a řeknu vám na rovinu, jestli mohu pomoci.`,
    followup2Subject: (name) => `Poslední zpráva ohledně ${name}`,
    followup2Opener: (name) => `Moje poslední zpráva ohledně ${name}.`,
    followup2Note: 'Pro úplnost, tady je poznámka, kterou jsem si udělal, když jsem si vás vyhledal: {{angle}}',
    followup2Close:
      'Pokud prostě není vhodná doba, není třeba odpovídat a téma uzavřu. Kdyby se to později změnilo, odpovězte na tuto zprávu a navážu tam, kde jsme skončili.',
    angleFallback:
      'Konkrétně jsem měl na mysli omezení ruční administrativy kolem poptávek a jejich vyřizování.',
    genericNiche: 'firmám, jako je ta vaše',
  },

  hu: {
    name: 'Hungarian',
    initialSubject: (name) => `Egy gyors ötlet a(z) ${name} számára`,
    initialOpener: (name, where) => `Üdvözlöm, rátaláltam a(z) ${name} cégre${where ? ` (${where})` : ''}.`,
    initialFallbackIntro: (niche) =>
      `${niche ? `${niche} területen működő` : 'Önökéhez hasonló'} vállalkozásokkal dolgozom a mindennapi, ismétlődő feladatok automatizálásán.`,
    askInitial: (name) =>
      `Találgatás helyett inkább egyenesen megkérdezem: mi az a probléma a(z) ${name} cégnél, amelyet szívesen rábíznának a technológiára? Pontosan ilyen dolgokat oldok meg helyi vállalkozásoknak. Írja meg, mi okoz fejfájást, és őszintén megmondom, tudok-e segíteni.`,
    followup1Subject: (name) => `Utánkövetés: ${name}`,
    followup1Opener: (name) =>
      `Múlt héten írtam Önnek a(z) ${name} kapcsán, de nem érkezett válasz. Semmi gond, a postafiókok már csak ilyenek.`,
    askFollowup1: (name) =>
      `Őszinte kérdés, mindenféle értékesítési szándék nélkül: mi az a probléma a(z) ${name} cégnél, amelyet a technológiának egyszerűen meg kellene oldania Önök helyett? Pontosan ezen dolgozom helyi vállalkozásokkal. Válaszoljon, miről van szó, és kertelés nélkül megmondom, tudok-e segíteni.`,
    followup2Subject: (name) => `Utolsó üzenet a(z) ${name} ügyében`,
    followup2Opener: (name) => `Az utolsó üzenetem a(z) ${name} ügyében.`,
    followup2Note: 'Ha már itt tartunk, itt a jegyzet, amelyet készítettem, amikor utánanéztem Önöknek: {{angle}}',
    followup2Close:
      'Ha egyszerűen nem megfelelő az időzítés, nem szükséges válaszolni, lezárom az ügyet. Ha ez később változna, válaszoljon erre az üzenetre, és folytatjuk ott, ahol abbahagytuk.',
    angleFallback:
      'Konkrétan arra gondoltam, hogy csökkentsük a megkeresések és az utánkövetés körüli kézi adminisztrációt.',
    genericNiche: 'Önökéhez hasonló vállalkozásokkal',
  },

  el: {
    name: 'Greek',
    initialSubject: (name) => `Μια γρήγορη ιδέα για την ${name}`,
    initialOpener: (name, where) => `Καλησπέρα σας, έπεσα πάνω στην ${name}${where ? ` στην περιοχή ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Συνεργάζομαι με ${niche || 'επιχειρήσεις σαν τη δική σας'} για την αυτοματοποίηση των επαναλαμβανόμενων εργασιών της ημέρας.`,
    askInitial: (name) =>
      `Αντί να μαντεύω, προτιμώ να ρωτήσω ευθέως: ποιο πρόβλημα στην ${name} θα θέλατε να το αναλάβει η τεχνολογία; Ακριβώς τέτοια πράγματα λύνω για τοπικές επιχειρήσεις. Πείτε μου τι σας δυσκολεύει και θα σας πω ειλικρινά αν μπορώ να βοηθήσω.`,
    followup1Subject: (name) => `Σε συνέχεια για την ${name}`,
    followup1Opener: (name) =>
      `Σας έγραψα την περασμένη εβδομάδα για την ${name} χωρίς απάντηση. Κανένα πρόβλημα, τα εισερχόμενα είναι εισερχόμενα.`,
    askFollowup1: (name) =>
      `Μια ειλικρινής ερώτηση, χωρίς καμία πρόταση πώλησης: ποιο πρόβλημα στην ${name} θα έπρεπε απλώς να σας το λύσει η τεχνολογία; Ακριβώς πάνω σε αυτό δουλεύω με τοπικές επιχειρήσεις. Απαντήστε μου τι είναι και θα σας πω ξεκάθαρα αν μπορώ να βοηθήσω.`,
    followup2Subject: (name) => `Τελευταίο μήνυμα για την ${name}`,
    followup2Opener: (name) => `Το τελευταίο μου μήνυμα για την ${name}.`,
    followup2Note: 'Για ό,τι αξίζει, ορίστε η σημείωση που κράτησα όταν σας αναζήτησα: {{angle}}',
    followup2Close:
      'Αν απλώς δεν είναι η κατάλληλη στιγμή, δεν χρειάζεται απάντηση και κλείνω το θέμα. Αν αυτό αλλάξει αργότερα, απαντήστε σε αυτό το μήνυμα και θα το συνεχίσουμε από εκεί.',
    angleFallback:
      'Αυτό που είχα συγκεκριμένα στο μυαλό μου είναι η μείωση της χειροκίνητης διαχείρισης γύρω από τα αιτήματα και την παρακολούθησή τους.',
    genericNiche: 'επιχειρήσεις σαν τη δική σας',
  },

  bg: {
    name: 'Bulgarian',
    initialSubject: (name) => `Бърза идея за ${name}`,
    initialOpener: (name, where) => `Здравейте, попаднах на ${name}${where ? ` в ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Работя с ${niche || 'фирми като Вашата'} по автоматизирането на повтарящите се задачи от ежедневието.`,
    askInitial: (name) =>
      `Вместо да гадая, предпочитам да попитам направо: кой проблем в ${name} бихте искали технологията да поеме вместо Вас? Точно такива неща решавам за местни фирми. Кажете ми какво Ви пречи и ще Ви отговоря честно дали мога да помогна.`,
    followup1Subject: (name) => `Във връзка с ${name}`,
    followup1Opener: (name) =>
      `Писах Ви миналата седмица относно ${name} и не получих отговор. Няма проблем, пощенските кутии са си пощенски кутии.`,
    askFollowup1: (name) =>
      `Искрен въпрос, без никакво търговско предложение: кой проблем в ${name} технологията просто трябва да реши вместо Вас? Точно с това се занимавам с местни фирми. Отговорете какво е и ще Ви кажа направо дали мога да помогна.`,
    followup2Subject: (name) => `Последно съобщение относно ${name}`,
    followup2Opener: (name) => `Последното ми съобщение относно ${name}.`,
    followup2Note: 'За всеки случай, ето бележката, която си направих, когато Ви потърсих: {{angle}}',
    followup2Close:
      'Ако моментът просто не е подходящ, не е нужно да отговаряте и ще приключа темата. Ако това се промени по-късно, отговорете на това съобщение и ще продължим оттам.',
    angleFallback:
      'Конкретно имах предвид намаляването на ръчната административна работа около запитванията и последващата им обработка.',
    genericNiche: 'фирми като Вашата',
  },

  tr: {
    name: 'Turkish',
    initialSubject: (name) => `${name} için kısa bir fikir`,
    initialOpener: (name, where) => `Merhaba, ${name}${where ? ` (${where})` : ''} ile karşılaştım.`,
    initialFallbackIntro: (niche) =>
      `${niche ? `${niche} alanındaki` : 'Sizinki gibi'} işletmelerle günlük işlerin tekrar eden kısımlarını otomatikleştirmek üzerine çalışıyorum.`,
    askInitial: (name) =>
      `Tahmin etmek yerine doğrudan sormayı tercih ederim: ${name} bünyesinde teknolojinin sizin yerinize halletmesini istediğiniz bir sorun nedir? Yerel işletmeler için tam olarak bu tür şeyleri çözüyorum. Sizi neyin zorladığını yazın, yardımcı olup olamayacağımı dürüstçe söyleyeyim.`,
    followup1Subject: (name) => `${name} hakkında takip`,
    followup1Opener: (name) =>
      `Geçen hafta ${name} hakkında yazmıştım ancak yanıt alamadım. Sorun değil, gelen kutuları böyledir.`,
    askFollowup1: (name) =>
      `Satış amacı taşımayan samimi bir soru: ${name} bünyesinde teknolojinin sizin için çözmesi gereken bir sorun nedir? Yerel işletmelerle tam olarak bunun üzerinde çalışıyorum. Ne olduğunu yanıtlayın, yardımcı olup olamayacağımı açıkça söyleyeyim.`,
    followup2Subject: (name) => `${name} hakkında son mesaj`,
    followup2Opener: (name) => `${name} hakkında benden son mesaj.`,
    followup2Note: 'Ne kadar işe yarar bilmem ama sizi araştırırken aldığım not şuydu: {{angle}}',
    followup2Close:
      'Zamanlama uygun değilse yanıt vermenize gerek yok, konuyu kapatıyorum. İleride bu değişirse bu mesaja yanıt verin, kaldığımız yerden devam ederim.',
    angleFallback:
      'Aklımdaki asıl konu, talepler ve takip süreçlerindeki manuel idari işleri azaltmaktı.',
    genericNiche: 'sizinki gibi işletmelerle',
  },

  ja: {
    name: 'Japanese',
    initialSubject: (name) => `${name}様へのご提案`,
    initialOpener: (name, where) => `${name}様${where ? `（${where}）` : ''}を拝見し、ご連絡いたしました。`,
    initialFallbackIntro: (niche) =>
      `${niche ? `${niche}の` : '御社のような'}企業様と共に、日々の繰り返し業務の自動化に取り組んでおります。`,
    askInitial: (name) =>
      `推測するよりも率直にお伺いしたいのですが、${name}様において「これを技術で解決できたら」と思われる課題は何でしょうか。私は地域の企業様のまさにそのような課題を解決しております。お困りの点をお知らせいただければ、お力になれるかどうか率直にお答えいたします。`,
    followup1Subject: (name) => `${name}様への再度のご連絡`,
    followup1Opener: (name) =>
      `先週${name}様についてご連絡いたしましたが、お返事をいただけておりませんでした。お忙しいことと存じますので、お気になさらないでください。`,
    askFollowup1: (name) =>
      `営業目的ではなく、率直にお伺いします。${name}様において、技術に任せてしまいたい課題は何でしょうか。私は地域の企業様とまさにその点に取り組んでおります。お返事をいただければ、お力になれるかどうか率直にお伝えいたします。`,
    followup2Subject: (name) => `${name}様への最後のご連絡`,
    followup2Opener: (name) => `${name}様への最後のご連絡となります。`,
    followup2Note: 'ご参考までに、御社を拝見した際に私が記したメモをお伝えいたします：{{angle}}',
    followup2Close:
      'タイミングが合わないようでしたら、ご返信は不要です。この件はいったん区切らせていただきます。今後状況が変わりましたら、このメールにご返信いただければ改めてお話しさせていただきます。',
    angleFallback:
      '具体的には、お問い合わせ対応とフォローアップにかかる手作業の事務処理を減らすことを考えておりました。',
    genericNiche: '御社のような企業様',
  },

  id: {
    name: 'Indonesian',
    initialSubject: (name) => `Ide singkat untuk ${name}`,
    initialOpener: (name, where) => `Halo, saya menemukan ${name}${where ? ` di ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Saya bekerja sama dengan ${niche || 'bisnis seperti milik Anda'} untuk mengotomatiskan pekerjaan rutin sehari-hari.`,
    askInitial: (name) =>
      `Daripada menebak-nebak, saya lebih memilih bertanya langsung: masalah apa di ${name} yang Anda harap bisa diatasi oleh teknologi? Hal seperti itulah yang saya bantu selesaikan untuk bisnis lokal. Ceritakan apa yang mengganggu Anda, dan saya akan menjawab dengan jujur apakah saya bisa membantu.`,
    followup1Subject: (name) => `Menindaklanjuti ${name}`,
    followup1Opener: (name) =>
      `Saya mengirim email minggu lalu tentang ${name} dan belum mendapat balasan. Tidak masalah, kotak masuk memang begitu.`,
    askFollowup1: (name) =>
      `Pertanyaan tulus, tanpa promosi: masalah apa di ${name} yang seharusnya bisa diselesaikan begitu saja oleh teknologi? Itulah yang saya kerjakan bersama bisnis lokal. Balas dengan masalahnya, dan saya akan mengatakan terus terang apakah saya bisa membantu.`,
    followup2Subject: (name) => `Pesan terakhir tentang ${name}`,
    followup2Opener: (name) => `Pesan terakhir dari saya tentang ${name}.`,
    followup2Note: 'Sekadar berbagi, ini catatan yang saya buat ketika mencari tahu tentang Anda: {{angle}}',
    followup2Close:
      'Jika waktunya memang belum tepat, tidak perlu membalas dan saya akan menutup pembahasan ini. Jika nanti berubah, balas saja pesan ini dan saya akan melanjutkannya.',
    angleFallback:
      'Yang saya pikirkan secara khusus adalah memangkas pekerjaan administrasi manual seputar pertanyaan masuk dan tindak lanjutnya.',
    genericNiche: 'bisnis seperti milik Anda',
  },

  ms: {
    name: 'Malay',
    initialSubject: (name) => `Idea ringkas untuk ${name}`,
    initialOpener: (name, where) => `Salam sejahtera, saya terjumpa ${name}${where ? ` di ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `Saya bekerjasama dengan ${niche || 'perniagaan seperti anda'} untuk mengautomasikan tugasan rutin harian.`,
    askInitial: (name) =>
      `Daripada meneka, saya lebih suka bertanya secara langsung: apakah satu masalah di ${name} yang anda harap dapat diselesaikan oleh teknologi? Perkara seperti itulah yang saya bantu selesaikan untuk perniagaan tempatan. Beritahu saya apa yang mengganggu anda, dan saya akan menjawab dengan jujur sama ada saya boleh membantu.`,
    followup1Subject: (name) => `Susulan mengenai ${name}`,
    followup1Opener: (name) =>
      `Saya menulis minggu lepas mengenai ${name} tetapi belum menerima balasan. Tidak mengapa, peti masuk memang begitu.`,
    askFollowup1: (name) =>
      `Soalan ikhlas, tanpa sebarang jualan: apakah satu masalah di ${name} yang sepatutnya diselesaikan begitu sahaja oleh teknologi? Itulah yang saya usahakan bersama perniagaan tempatan. Balas dengan masalahnya, dan saya akan berterus terang sama ada saya boleh membantu.`,
    followup2Subject: (name) => `Mesej terakhir mengenai ${name}`,
    followup2Opener: (name) => `Mesej terakhir daripada saya mengenai ${name}.`,
    followup2Note: 'Sekadar perkongsian, ini nota yang saya catat semasa mencari maklumat tentang anda: {{angle}}',
    followup2Close:
      'Jika masanya memang tidak sesuai, tidak perlu membalas dan saya akan menutup perkara ini. Jika keadaan berubah kemudian, balas mesej ini dan saya akan menyambungnya semula.',
    angleFallback:
      'Perkara khusus yang saya fikirkan ialah mengurangkan kerja pentadbiran manual berkaitan pertanyaan dan susulan.',
    genericNiche: 'perniagaan seperti anda',
  },

  ar: {
    name: 'Arabic',
    initialSubject: (name) => `فكرة سريعة لـ ${name}`,
    initialOpener: (name, where) => `مرحباً، لقد اطّلعت على ${name}${where ? ` في ${where}` : ''}.`,
    initialFallbackIntro: (niche) =>
      `أعمل مع ${niche || 'شركات مثل شركتكم'} على أتمتة المهام المتكررة في العمل اليومي.`,
    askInitial: (name) =>
      `بدلاً من التخمين، أفضّل أن أسأل مباشرةً: ما المشكلة في ${name} التي تتمنون لو تولّتها التقنية عنكم؟ هذا بالضبط ما أساعد الشركات المحلية على حلّه. أخبروني بما يزعجكم وسأخبركم بصدق إن كان بإمكاني المساعدة.`,
    followup1Subject: (name) => `متابعة بخصوص ${name}`,
    followup1Opener: (name) =>
      `راسلتكم الأسبوع الماضي بخصوص ${name} ولم يصلني رد. لا بأس، فصناديق البريد مزدحمة دائماً.`,
    askFollowup1: (name) =>
      `سؤال صادق دون أي عرض بيع: ما المشكلة في ${name} التي ينبغي للتقنية أن تحلّها عنكم ببساطة؟ هذا بالضبط ما أعمل عليه مع الشركات المحلية. أجيبوني بما هي وسأخبركم بصراحة إن كان بإمكاني المساعدة.`,
    followup2Subject: (name) => `رسالة أخيرة بخصوص ${name}`,
    followup2Opener: (name) => `رسالتي الأخيرة بخصوص ${name}.`,
    followup2Note: 'للفائدة، هذه هي الملاحظة التي دوّنتها عندما بحثت عنكم: {{angle}}',
    followup2Close:
      'إن لم يكن التوقيت مناسباً، فلا حاجة للرد وسأغلق الموضوع. وإن تغيّر ذلك لاحقاً، فما عليكم سوى الرد على هذه الرسالة وسأستأنف الحديث من حيث توقفنا.',
    angleFallback:
      'ما كنت أفكر فيه تحديداً هو تقليل العمل الإداري اليدوي المرتبط بالاستفسارات ومتابعتها.',
    genericNiche: 'شركات مثل شركتكم',
  },
};

/** The pack for a code, falling back to English for anything unknown. */
export function languagePack(code: string | null | undefined): LanguagePack {
  return isLanguageCode(code) ? LANGUAGES[code] : LANGUAGES.en;
}
