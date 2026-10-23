export type Lang = "en" | "nl";

export const LANGS: { code: Lang; label: string; short: string }[] = [
  { code: "en", label: "English", short: "EN" },
  { code: "nl", label: "Dutch", short: "NL" },
];

// Why a file could not be attached; the composer turns this into a message in the chosen language
export type AttachmentProblem =
  | { kind: "tooMany"; max: number }
  | { kind: "imageTooBig"; file: string }
  | { kind: "unreadableImage"; file: string }
  | { kind: "binaryFile"; file: string }
  | { kind: "textTooLong"; file: string; max: number }
  | { kind: "documentTooBig"; file: string }
  | { kind: "unreadableDocument"; file: string }
  | { kind: "noText"; file: string }
  | { kind: "oldWord"; file: string }
  | { kind: "unsupported"; file: string };

// Error codes returned by /api/chat
export type ApiErrorCode =
  | "not_configured"
  | "invalid_request"
  | "attachments_invalid"
  | "not_found"
  | "n8n_status"
  | "no_answer"
  | "too_slow"
  | "unreachable"
  | "rate_limited"
  | "server_unreachable";

export type Strings = {
  appName: string;
  newChat: string;
  chats: string;
  noChats: string;
  renameChat: string;
  deleteChat: string;
  save: string;
  cancel: string;
  openChats: string;
  welcomeTitle: string;
  welcomeSub: string;
  examples: string[];
  placeholder: string;
  disclaimer: string;
  attachFiles: string;
  send: string;
  removeFile: (name: string) => string;
  sources: string;
  sourceLines: (start: number, end: number) => string;
  showPassage: string;
  followUps: string;
  tierLabel: (tier: string) => string;
  tierReason: (reason: string) => string;
  lookAtAttachments: string;
  languageLabel: string;
  brandSubtitle: string;
  collapseSidebar: string;
  expandSidebar: string;
  searchChats: string;
  noMatches: string;
  groupToday: string;
  groupYesterday: string;
  groupWeek: string;
  groupOlder: string;
  deleteConfirm: string;
  copy: string;
  copied: string;
  thinking: string;
  retry: string;
  customerLabel: string;
  customerPlaceholder: string;
  versionLabel: string;
  versionAny: string;
  scopeHint: string;
  feedbackGood: string;
  feedbackBad: string;
  feedbackPromptBad: string;
  feedbackPlaceholder: string;
  feedbackSend: string;
  feedbackSaved: string;
  feedbackNotSaved: string;
  feedbackReported: string;
  cachedLabel: string;
  cachedHint: string;
  cachedRefresh: string;
  feedbackTooShort: string;
  feedbackFailed: string;
  lessonUsed: (n: number) => string;
  errorTitle: string;
  enterHint: string;
  exampleLabels: string[];
  hintFiles: string;
  // the two tabs: Advisor Chat and Quick Reports
  tabsLabel: string;
  tabAdvisor: string;
  tabQuickReports: string;
  quickReportTitle: string;
  quickReportSub: string;
  quickReportExamples: string[];
  quickReportLabels: string[];
  quickReportHint: string;
  quickReportPlaceholder: string;
  newQuickReport: string;
  // after a design was reviewed: approve it, then choose what happens next
  nextChecking: string;
  nextCheckFailed: string;
  nextRunLostA: string;
  nextRunLostB: string;
  // the test run of a report that exists in IFS
  nextTestTitle: string;
  nextTestIntro: string;
  nextTestImportFirst: string;
  nextTestRehearsalMode: string;
  nextTestReportId: string;
  nextTestReportIdHint: string;
  nextTestParameters: string;
  nextTestProblem: (code: string, name?: string) => string;
  nextTestEmpty: (name: string) => string;
  nextTestStart: string;
  nextTestConfirmTitleRun: string;
  nextTestConfirmBodyRun: (target: string) => string;
  nextTestConfirmTitleRehearsal: string;
  nextTestConfirmBodyRehearsal: (target: string) => string;
  nextTestPrivacy: string;
  nextTestYesRun: string;
  nextTestYesRehearsal: string;
  nextTestRunning: string;
  nextTestResultTitle: string;
  nextTestColumnsMatch: string;
  nextTestColumnsDiffer: string;
  nextTestRows: (n: number, more: boolean) => string;
  nextTestSeconds: (s: number) => string;
  nextTestScreenshot: string;
  nextTestAgain: string;
  nextTestRealEnvironment: string;
  nextTestLost: string;
  nextRetry: string;
  nextBlockedTitle: string;
  nextReadyTitle: string;
  nextReadySub: string;
  nextOpenQuestions: string;
  nextValidation: (checked: number, unknownViews: number, unknownColumns: number) => string;
  nextApprove: string;
  nextOptionsTitle: string;
  nextNothingYet: string;
  nextOptionATitle: string;
  nextOptionADesc: string;
  nextOptionBTitle: string;
  nextOptionBDesc: string;
  nextChooseA: string;
  nextChooseB: string;
  nextNeeds: string;
  nextConfirmTitle: string;
  nextConfirmBody: (target: string) => string;
  nextConfirmYes: string;
  nextConfirmTitleRehearsal: string;
  nextConfirmBodyRehearsal: (target: string) => string;
  nextConfirmYesRehearsal: string;
  nextCancel: string;
  nextRunning: string;
  nextResultTitle: string;
  nextBack: string;
  nextTouched: (what: string) => string;
  nextStepOk: string;
  nextStepFailed: string;
  nextStepNotDone: string;
  nextDownload: string;
  nextHowToImport: string;
  nextWarnings: string;
  themeLabel: string;
  themeLight: string;
  themeDark: string;
  themeSystem: string;
  errorPrefix: string;
  genericError: string;
  apiError: (code: ApiErrorCode | undefined, fallback: string | undefined) => string;
  attachmentProblem: (p: AttachmentProblem) => string;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (n: number, lang: Lang) => n.toLocaleString(lang === "nl" ? "nl-NL" : "en-US");

export const STRINGS: Record<Lang, Strings> = {
  en: {
    appName: "Advisor Agent",
    newChat: "New chat",
    chats: "Chats",
    noChats: "No chats yet. Ask your first question.",
    renameChat: "Rename chat",
    deleteChat: "Delete chat",
    save: "Save",
    cancel: "Cancel",
    openChats: "Open chats",
    welcomeTitle: "How can I help with IFS Cloud?",
    welcomeSub: "Ask a functional or technical question.",
    examples: [
      "How do I configure a project budget in IFS Cloud?",
      "What is the difference between a Customer Order and a Sales Quotation?",
      "Which IFS Cloud release introduced the new Aurena navigator?",
    ],
    placeholder: "Ask about IFS Cloud…",
    disclaimer: "Answers are based on the approved sources and cite them. Always check critical details in the official documentation.",
    attachFiles: "Attach files",
    send: "Send",
    removeFile: (name) => `Remove ${name}`,
    sources: "Sources",
    sourceLines: (a, b) => `lines ${a}–${b}`,
    showPassage: "Show passage",
    followUps: "You could also ask",
    tierLabel: (tier) => `${cap(tier)} tier`,
    tierReason: (reason) => `Chosen because: ${reason}`,
    lookAtAttachments: "Please look at the attached file(s).",
    languageLabel: "Language",
    brandSubtitle: "IFS Cloud advisor",
    collapseSidebar: "Hide sidebar",
    expandSidebar: "Show sidebar",
    searchChats: "Search chats",
    noMatches: "No chats match your search.",
    groupToday: "Today",
    groupYesterday: "Yesterday",
    groupWeek: "Previous 7 days",
    groupOlder: "Older",
    deleteConfirm: "Delete this chat?",
    copy: "Copy answer",
    copied: "Copied",
    thinking: "Thinking…",
    retry: "Try again",
    customerLabel: "Customer",
    customerPlaceholder: "Customer (optional)",
    versionLabel: "IFS version",
    versionAny: "Any version",
    scopeHint: "Saved answers and notes apply only to this customer and version.",
    feedbackGood: "Good answer",
    feedbackBad: "Not right",
    feedbackPromptBad: "What is wrong, unsupported or missing in this answer?",
    feedbackPlaceholder: "Describe the problem in your own words…",
    feedbackSend: "Send",
    feedbackSaved: "Thanks. This answer is saved and will be shown again for the same question.",
    feedbackNotSaved: "Thanks. This answer is not saved for reuse, because files were attached in this chat.",
    feedbackReported: "Thanks. Your note is saved. It is not treated as a verified correction; it is only used to double-check later answers.",
    cachedLabel: "Saved answer",
    cachedHint: "A consultant rated this answer as good. It was returned as it was, without asking the AI again.",
    cachedRefresh: "Get a new answer",
    feedbackTooShort: "Please write a little more (at least 8 characters).",
    feedbackFailed: "Could not send this right now. Please try again.",
    lessonUsed: (n) => (n === 1 ? "Used 1 confirmed lesson" : `Used ${n} confirmed lessons`),
    errorTitle: "Could not get an answer",
    enterHint: "Enter to send, Shift+Enter for a new line",
    exampleLabels: ["Configuration", "Concepts", "Releases"],
    hintFiles: "Paste or drop screenshots and files into the message box.",
    tabsLabel: "Workspace",
    tabAdvisor: "Advisor Chat",
    tabQuickReports: "Quick Reports",
    quickReportTitle: "Design an IFS quick report",
    quickReportSub: "Describe the report or attach its specification. You get a design with a review page to approve or change.",
    quickReportExamples: [
      "Create a quick report 'Open Customer Invoices' for one company, with the parameter Due Before and the columns Invoice No, Customer, Due Date and Amount.",
      "Create a quick report that lists the open customer orders of a site with order number, customer and wanted delivery date, with the parameters Site and Delivery Before.",
      "Create a quick report that lists the customer invoices of a company with their payment terms and due dates.",
    ],
    quickReportLabels: ["Invoices", "Customer orders", "Payment terms"],
    quickReportHint: "Attach the Word or PDF specification of the report to the message. The SQL is checked against the IFS data dictionary only; it is not run on an IFS environment.",
    quickReportPlaceholder: "Describe the quick report…",
    newQuickReport: "New quick report",
    nextChecking: "Checking whether the design is ready for the next step…",
    nextCheckFailed: "The design could not be checked right now.",
    nextRunLostA: "The answer of the backend was lost, so it is not known whether the quick report was created. Check the Quick Reports list in IFS before you try again, so that it is not created twice.",
    nextRunLostB: "The answer of the backend was lost. This option never opens or changes IFS: you can try again.",
    nextRetry: "Check again",
    nextBlockedTitle: "Not ready for the next step yet",
    nextReadyTitle: "The design is ready for your approval",
    nextReadySub: "Approve it to choose what happens next. Nothing is created or exported until you choose.",
    nextOpenQuestions: "Still open (you can approve anyway, or ask for a change first)",
    nextValidation: (c, v, col) => `Checked against the IFS data dictionary only: ${c} column reference(s), ${v} unknown view(s), ${col} unknown column(s). The SQL has not been run on any IFS environment.`,
    nextApprove: "Approve design",
    nextOptionsTitle: "How do you want to continue?",
    nextNothingYet: "Nothing happens until you choose one of these.",
    nextOptionATitle: "Option A: create it directly in IFS",
    nextOptionADesc: "Opens the IFS environment with Playwright and fills in the New Report dialog with your design. While the rehearsal is on, it cancels the dialog and saves nothing; otherwise it saves the report. The SQL is not run. You confirm once more first.",
    nextOptionBTitle: "Option B: generate an export file",
    nextOptionBDesc: "Generates the export file of the quick report for you to import into IFS yourself. IFS is not opened or changed.",
    nextChooseA: "Choose Option A",
    nextChooseB: "Choose Option B",
    nextNeeds: "Not available yet. Needs:",
    nextConfirmTitle: "Create the quick report in IFS?",
    nextConfirmBody: (target) => `This opens ${target} with your saved session and creates the quick report there. It changes the IFS environment.`,
    nextConfirmYes: "Yes, create it in IFS",
    nextConfirmTitleRehearsal: "Rehearse in IFS? Nothing will be saved",
    nextConfirmBodyRehearsal: (target) => `This opens ${target} with your saved session in a visible browser, fills in the New Report dialog with your design, and cancels it. Nothing is saved. It shows whether the fields are found.`,
    nextConfirmYesRehearsal: "Yes, rehearse (nothing is saved)",
    nextCancel: "Cancel",
    nextRunning: "Running…",
    nextResultTitle: "Result",
    nextBack: "Back to the options",
    nextTouched: (what) => `IFS: ${what}`,
    nextStepOk: "done",
    nextStepFailed: "failed",
    nextStepNotDone: "not done",
    nextTestTitle: "Test run in IFS",
    nextTestIntro: "IFS runs the SQL of the report (a read-only SELECT) with the values you type, and this page shows what IFS returns: the columns, the first rows, how long it took, and a screenshot. The report has to exist in IFS.",
    nextTestImportFirst: "Import the file in IFS first (Option B): the test run opens the report that is in IFS.",
    nextTestRehearsalMode: "Rehearsal: the report is opened and its parameters are filled in, but Execute is not pressed, so the SQL is not run (IFS_TEST_EXECUTE is off).",
    nextTestReportId: "Report id",
    nextTestReportIdHint: "The number in the projection name of the report in IFS (QuickReport<id>).",
    nextTestParameters: "Values of the parameters",
    nextTestProblem: (code, name) =>
      code === "id" ? "The report id must be a number."
      : code === "long" ? `The value of ${name} is too long (at most 100 characters).`
      : code === "unsafe" ? `The value of ${name} may not contain quotes, semicolons, ampersands or comment marks.`
      : `The parameter ${name} is mandatory: it needs a value.`,
    nextTestEmpty: (name) => `${name} is empty: the report may return all rows.`,
    nextTestStart: "Test run in IFS",
    nextTestConfirmTitleRun: "Run the SQL in IFS?",
    nextTestConfirmBodyRun: (target) => `This opens ${target} with your saved session and runs the report with these values: IFS executes its SELECT. Nothing in IFS is changed.`,
    nextTestConfirmTitleRehearsal: "Rehearse the test run? The SQL will not be run",
    nextTestConfirmBodyRehearsal: (target) => `This opens ${target} in a visible browser, finds the parameters of the report and fills them in. It does not press Execute.`,
    nextTestPrivacy: "The rows and the screenshot can contain customer data. They are shown on this page only: they are not saved, not logged, not part of the chat, and not sent to the AI model.",
    nextTestYesRun: "Yes, run it",
    nextTestYesRehearsal: "Yes, rehearse (the SQL is not run)",
    nextTestRunning: "Running in IFS…",
    nextTestResultTitle: "Test run",
    nextTestColumnsMatch: "The columns are those of the design",
    nextTestColumnsDiffer: "The columns are not those of the design",
    nextTestRows: (n, more) => `${n}${more ? "+" : ""} row(s) read`,
    nextTestSeconds: (s) => `${s} s`,
    nextTestScreenshot: "Screenshot of the result in IFS",
    nextTestAgain: "Test again",
    nextTestRealEnvironment: "Real environment",
    nextTestLost: "The answer of the backend was lost, so it is not known whether the report was run in IFS. Look at the report in IFS before you try again.",
    nextDownload: "Download the file",
    nextHowToImport: "How to import it in IFS",
    nextWarnings: "Please note",
    themeLabel: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    errorPrefix: "Error:",
    genericError: "Something went wrong.",
    apiError: (code, fallback) => {
      switch (code) {
        case "not_configured":
          return "The server is not set up to reach n8n (N8N_WEBHOOK_URL is missing).";
        case "invalid_request":
          return "The request was not valid.";
        case "attachments_invalid":
          return "The attachments are not valid. Use up to 4 images, Word, PDF or text files within the size limits.";
        case "not_found":
          return "The n8n webhook was not found. Is the workflow active and does the URL match?";
        case "no_answer":
          return "The n8n workflow did not return an answer. Check the Executions tab in n8n for the failing node.";
        case "too_slow":
          return "The advisor took too long to respond.";
        case "unreachable":
          return "Could not reach n8n. Is it running?";
        case "rate_limited":
          return "Too many requests in a short time. Please wait a moment and try again.";
        case "server_unreachable":
          return "The service could not be reached. Please try again in a moment.";
        default:
          return fallback ?? "Something went wrong.";
      }
    },
    attachmentProblem: (p) => {
      switch (p.kind) {
        case "tooMany":
          return `You can attach up to ${p.max} files per message.`;
        case "imageTooBig":
          return `${p.file}: the image is larger than 15 MB.`;
        case "unreadableImage":
          return `${p.file}: this image could not be read.`;
        case "binaryFile":
          return `${p.file}: this looks like a binary file, not text.`;
        case "textTooLong":
          return `${p.file}: the file is too long (maximum ${num(p.max, "en")} characters).`;
        case "documentTooBig":
          return `${p.file}: the file is larger than 25 MB.`;
        case "unreadableDocument":
          return `${p.file}: this document could not be read. It may be damaged or protected with a password.`;
        case "noText":
          return `${p.file}: no text was found in this document. A scanned PDF has no text layer: attach it as images or use a version with text.`;
        case "oldWord":
          return `${p.file}: old Word files (.doc) cannot be read. Save the document as .docx and attach that.`;
        case "unsupported":
          return `${p.file}: not supported yet. Attach images, Word (docx) or PDF files, or text files (txt, md, csv, json, xml, log, sql, yaml).`;
      }
    },
  },
  nl: {
    appName: "Advisor Agent",
    newChat: "Nieuwe chat",
    chats: "Chats",
    noChats: "Nog geen chats. Stel uw eerste vraag.",
    renameChat: "Chat hernoemen",
    deleteChat: "Chat verwijderen",
    save: "Opslaan",
    cancel: "Annuleren",
    openChats: "Chats openen",
    welcomeTitle: "Waarmee kan ik u helpen met IFS Cloud?",
    welcomeSub: "Stel een functionele of technische vraag.",
    examples: [
      "Hoe stel ik een projectbudget in IFS Cloud in?",
      "Wat is het verschil tussen een Customer Order en een Sales Quotation?",
      "Welke IFS Cloud-release introduceerde de nieuwe Aurena-navigator?",
    ],
    placeholder: "Stel een vraag over IFS Cloud…",
    disclaimer:
      "Antwoorden zijn gebaseerd op de goedgekeurde bronnen en verwijzen ernaar. Controleer kritieke details altijd in de officiële documentatie.",
    attachFiles: "Bijlagen toevoegen",
    send: "Verzenden",
    removeFile: (name) => `${name} verwijderen`,
    sources: "Bronnen",
    sourceLines: (a, b) => `regels ${a}–${b}`,
    showPassage: "Passage tonen",
    followUps: "U kunt ook vragen",
    tierLabel: (tier) => `${cap(tier)}-niveau`,
    tierReason: (reason) => `Gekozen omdat: ${reason}`,
    lookAtAttachments: "Bekijk de bijgevoegde bestand(en).",
    languageLabel: "Taal",
    brandSubtitle: "IFS Cloud-adviseur",
    collapseSidebar: "Zijbalk verbergen",
    expandSidebar: "Zijbalk tonen",
    searchChats: "Chats zoeken",
    noMatches: "Geen chats gevonden.",
    groupToday: "Vandaag",
    groupYesterday: "Gisteren",
    groupWeek: "Afgelopen 7 dagen",
    groupOlder: "Ouder",
    deleteConfirm: "Deze chat verwijderen?",
    copy: "Antwoord kopiëren",
    copied: "Gekopieerd",
    thinking: "Even nadenken…",
    retry: "Opnieuw proberen",
    customerLabel: "Klant",
    customerPlaceholder: "Klant (optioneel)",
    versionLabel: "IFS-versie",
    versionAny: "Elke versie",
    scopeHint: "Bewaarde antwoorden en opmerkingen gelden alleen voor deze klant en versie.",
    feedbackGood: "Goed antwoord",
    feedbackBad: "Niet juist",
    feedbackPromptBad: "Wat is er onjuist, niet onderbouwd of wat ontbreekt er in dit antwoord?",
    feedbackPlaceholder: "Beschrijf het probleem in uw eigen woorden…",
    feedbackSend: "Versturen",
    feedbackSaved: "Dank u. Dit antwoord is bewaard en wordt opnieuw getoond bij dezelfde vraag.",
    feedbackNotSaved: "Dank u. Dit antwoord wordt niet bewaard, omdat er in dit gesprek bestanden zijn bijgevoegd.",
    feedbackReported: "Dank u. Uw opmerking is bewaard. Ze geldt niet als geverifieerde correctie; ze helpt alleen om latere antwoorden extra te controleren.",
    cachedLabel: "Bewaard antwoord",
    cachedHint: "Een consultant beoordeelde dit antwoord als goed. Het is ongewijzigd teruggegeven, zonder de AI opnieuw te vragen.",
    cachedRefresh: "Nieuw antwoord ophalen",
    feedbackTooShort: "Schrijf iets meer (minimaal 8 tekens).",
    feedbackFailed: "Dit kon nu niet worden verstuurd. Probeer het opnieuw.",
    lessonUsed: (n) => (n === 1 ? "1 bevestigde les gebruikt" : `${n} bevestigde lessen gebruikt`),
    errorTitle: "Geen antwoord ontvangen",
    enterHint: "Enter om te verzenden, Shift+Enter voor een nieuwe regel",
    exampleLabels: ["Configuratie", "Begrippen", "Releases"],
    hintFiles: "Plak of sleep screenshots en bestanden in het berichtveld.",
    tabsLabel: "Werkruimte",
    tabAdvisor: "Advisor Chat",
    tabQuickReports: "Quick Reports",
    quickReportTitle: "Ontwerp een IFS quick report",
    quickReportSub: "Beschrijf het rapport of voeg de specificatie toe. U krijgt een ontwerp met een reviewpagina om goed te keuren of te wijzigen.",
    quickReportExamples: [
      "Maak een quick report 'Open Customer Invoices' voor één bedrijf, met de parameter Due Before en de kolommen Invoice No, Customer, Due Date en Amount.",
      "Maak een quick report dat de open klantorders van een site toont met ordernummer, klant en gewenste leverdatum, met de parameters Site en Delivery Before.",
      "Maak een quick report dat de klantfacturen van een bedrijf toont met betalingsvoorwaarden en vervaldatums.",
    ],
    quickReportLabels: ["Facturen", "Klantorders", "Betalingsvoorwaarden"],
    quickReportHint: "Voeg de Word- of PDF-specificatie van het rapport toe aan het bericht. De SQL wordt alleen gecontroleerd tegen het IFS-datawoordenboek; ze wordt niet op een IFS-omgeving uitgevoerd.",
    quickReportPlaceholder: "Beschrijf het quick report…",
    newQuickReport: "Nieuw quick report",
    nextChecking: "Controleren of het ontwerp klaar is voor de volgende stap…",
    nextCheckFailed: "Het ontwerp kon nu niet worden gecontroleerd.",
    nextRunLostA: "Het antwoord van de backend is verloren gegaan, dus het is niet bekend of het quick report is aangemaakt. Controleer de lijst met quick reports in IFS voordat u het opnieuw probeert, zodat het niet twee keer wordt aangemaakt.",
    nextRunLostB: "Het antwoord van de backend is verloren gegaan. Deze optie opent of wijzigt IFS nooit: u kunt het opnieuw proberen.",
    nextRetry: "Opnieuw controleren",
    nextBlockedTitle: "Nog niet klaar voor de volgende stap",
    nextReadyTitle: "Het ontwerp is klaar voor uw goedkeuring",
    nextReadySub: "Keur het goed om te kiezen wat er daarna gebeurt. Er wordt niets aangemaakt of geëxporteerd voordat u kiest.",
    nextOpenQuestions: "Nog open (u kunt toch goedkeuren, of eerst een wijziging vragen)",
    nextValidation: (c, v, col) => `Alleen gecontroleerd tegen het IFS-datawoordenboek: ${c} kolomverwijzing(en), ${v} onbekende view(s), ${col} onbekende kolom(men). De SQL is niet uitgevoerd op een IFS-omgeving.`,
    nextApprove: "Ontwerp goedkeuren",
    nextOptionsTitle: "Hoe wilt u verder?",
    nextNothingYet: "Er gebeurt niets totdat u een van deze opties kiest.",
    nextOptionATitle: "Optie A: direct in IFS aanmaken",
    nextOptionADesc: "Opent de IFS-omgeving met Playwright en vult het dialoogvenster Nieuw rapport in met uw ontwerp. Zolang de repetitie aanstaat, annuleert het het venster en slaat het niets op; anders slaat het het rapport op. De SQL wordt niet uitgevoerd. U bevestigt eerst nog een keer.",
    nextOptionBTitle: "Optie B: exportbestand maken",
    nextOptionBDesc: "Maakt het exportbestand van het quick report dat u zelf in IFS importeert. IFS wordt niet geopend of gewijzigd.",
    nextChooseA: "Kies optie A",
    nextChooseB: "Kies optie B",
    nextNeeds: "Nog niet beschikbaar. Nodig:",
    nextConfirmTitle: "Het quick report in IFS aanmaken?",
    nextConfirmBody: (target) => `Dit opent ${target} met uw opgeslagen sessie en maakt daar het quick report aan. Het wijzigt de IFS-omgeving.`,
    nextConfirmYes: "Ja, aanmaken in IFS",
    nextConfirmTitleRehearsal: "Repeteren in IFS? Er wordt niets opgeslagen",
    nextConfirmBodyRehearsal: (target) => `Dit opent ${target} met uw opgeslagen sessie in een zichtbare browser, vult het dialoogvenster Nieuw rapport in met uw ontwerp en annuleert het. Er wordt niets opgeslagen. Zo ziet u of de velden gevonden worden.`,
    nextConfirmYesRehearsal: "Ja, repeteren (niets wordt opgeslagen)",
    nextCancel: "Annuleren",
    nextRunning: "Bezig…",
    nextResultTitle: "Resultaat",
    nextBack: "Terug naar de opties",
    nextTouched: (what) => `IFS: ${what}`,
    nextStepOk: "gelukt",
    nextStepFailed: "mislukt",
    nextStepNotDone: "niet gedaan",
    nextTestTitle: "Testrun in IFS",
    nextTestIntro: "IFS voert de SQL van het rapport uit (een alleen-lezen SELECT) met de waarden die u typt, en deze pagina toont wat IFS teruggeeft: de kolommen, de eerste rijen, hoe lang het duurde en een screenshot. Het rapport moet in IFS bestaan.",
    nextTestImportFirst: "Importeer eerst het bestand in IFS (optie B): de testrun opent het rapport dat in IFS staat.",
    nextTestRehearsalMode: "Repetitie: het rapport wordt geopend en de parameters worden ingevuld, maar Execute wordt niet ingedrukt, dus de SQL wordt niet uitgevoerd (IFS_TEST_EXECUTE staat uit).",
    nextTestReportId: "Rapport-id",
    nextTestReportIdHint: "Het nummer in de projectienaam van het rapport in IFS (QuickReport<id>).",
    nextTestParameters: "Waarden van de parameters",
    nextTestProblem: (code, name) =>
      code === "id" ? "Het rapport-id moet een getal zijn."
      : code === "long" ? `De waarde van ${name} is te lang (maximaal 100 tekens).`
      : code === "unsafe" ? `De waarde van ${name} mag geen aanhalingstekens, puntkomma's, ampersands of commentaartekens bevatten.`
      : `De parameter ${name} is verplicht: er is een waarde nodig.`,
    nextTestEmpty: (name) => `${name} is leeg: het rapport kan alle rijen teruggeven.`,
    nextTestStart: "Testrun in IFS",
    nextTestConfirmTitleRun: "De SQL uitvoeren in IFS?",
    nextTestConfirmBodyRun: (target) => `Dit opent ${target} met uw opgeslagen sessie en voert het rapport uit met deze waarden: IFS voert de SELECT uit. Er wordt niets in IFS gewijzigd.`,
    nextTestConfirmTitleRehearsal: "De testrun repeteren? De SQL wordt niet uitgevoerd",
    nextTestConfirmBodyRehearsal: (target) => `Dit opent ${target} in een zichtbare browser, zoekt de parameters van het rapport en vult ze in. Execute wordt niet ingedrukt.`,
    nextTestPrivacy: "De rijen en de screenshot kunnen klantgegevens bevatten. Ze worden alleen op deze pagina getoond: ze worden niet opgeslagen, niet gelogd, maken geen deel uit van de chat en gaan niet naar het AI-model.",
    nextTestYesRun: "Ja, uitvoeren",
    nextTestYesRehearsal: "Ja, repeteren (de SQL wordt niet uitgevoerd)",
    nextTestRunning: "Bezig in IFS…",
    nextTestResultTitle: "Testrun",
    nextTestColumnsMatch: "De kolommen zijn die van het ontwerp",
    nextTestColumnsDiffer: "De kolommen zijn niet die van het ontwerp",
    nextTestRows: (n, more) => `${n}${more ? "+" : ""} rij(en) gelezen`,
    nextTestSeconds: (s) => `${s} s`,
    nextTestScreenshot: "Screenshot van het resultaat in IFS",
    nextTestAgain: "Opnieuw testen",
    nextTestRealEnvironment: "Echte omgeving",
    nextTestLost: "Het antwoord van de backend is verloren gegaan, dus het is niet bekend of het rapport in IFS is uitgevoerd. Kijk in IFS naar het rapport voordat u het opnieuw probeert.",
    nextDownload: "Download het bestand",
    nextHowToImport: "Zo importeert u het in IFS",
    nextWarnings: "Let op",
    themeLabel: "Thema",
    themeLight: "Licht",
    themeDark: "Donker",
    themeSystem: "Systeem",
    errorPrefix: "Fout:",
    genericError: "Er is iets misgegaan.",
    apiError: (code, fallback) => {
      switch (code) {
        case "not_configured":
          return "De server is niet ingesteld om n8n te bereiken (N8N_WEBHOOK_URL ontbreekt).";
        case "invalid_request":
          return "Het verzoek was ongeldig.";
        case "attachments_invalid":
          return "De bijlagen zijn ongeldig. Gebruik maximaal 4 afbeeldingen, Word-, pdf- of tekstbestanden binnen de groottelimieten.";
        case "not_found":
          return "De n8n-webhook is niet gevonden. Is de workflow actief en klopt de URL?";
        case "no_answer":
          return "De n8n-workflow gaf geen antwoord. Controleer het tabblad Executions in n8n voor de mislukte node.";
        case "too_slow":
          return "De adviseur deed er te lang over om te antwoorden.";
        case "unreachable":
          return "n8n is niet bereikbaar. Draait het?";
        case "rate_limited":
          return "Te veel verzoeken in korte tijd. Wacht even en probeer het opnieuw.";
        case "server_unreachable":
          return "De service is niet bereikbaar. Probeer het zo meteen opnieuw.";
        default:
          return fallback ?? "Er is iets misgegaan.";
      }
    },
    attachmentProblem: (p) => {
      switch (p.kind) {
        case "tooMany":
          return `U kunt maximaal ${p.max} bestanden per bericht toevoegen.`;
        case "imageTooBig":
          return `${p.file}: de afbeelding is groter dan 15 MB.`;
        case "unreadableImage":
          return `${p.file}: deze afbeelding kon niet worden gelezen.`;
        case "binaryFile":
          return `${p.file}: dit lijkt een binair bestand, geen tekst.`;
        case "textTooLong":
          return `${p.file}: het bestand is te lang (maximaal ${num(p.max, "nl")} tekens).`;
        case "documentTooBig":
          return `${p.file}: het bestand is groter dan 25 MB.`;
        case "unreadableDocument":
          return `${p.file}: dit document kon niet worden gelezen. Het is mogelijk beschadigd of met een wachtwoord beveiligd.`;
        case "noText":
          return `${p.file}: er is geen tekst gevonden in dit document. Een gescande pdf heeft geen tekstlaag: voeg het toe als afbeeldingen of gebruik een versie met tekst.`;
        case "oldWord":
          return `${p.file}: oude Word-bestanden (.doc) kunnen niet worden gelezen. Sla het document op als .docx en voeg dat toe.`;
        case "unsupported":
          return `${p.file}: wordt nog niet ondersteund. Voeg afbeeldingen, Word- (docx) of pdf-bestanden toe, of tekstbestanden (txt, md, csv, json, xml, log, sql, yaml).`;
      }
    },
  },
};
