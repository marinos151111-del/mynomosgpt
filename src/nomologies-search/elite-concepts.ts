// Extracted from the original MyNomosAI v11 controlled legal vocabulary.
// Visible labels remain one Greek word; the richer phrases are hidden search aliases.
export type EliteLegalConcept = {
  id: string;
  label: string;
  aliases: string[];
  type: "procedure" | "principle";
};

export const ELITE_LEGAL_CONCEPTS: EliteLegalConcept[] = [
  {
    "id": "elite_001",
    "label": "παράταση",
    "aliases": [
      "παράταση προθεσμίας",
      "παραταση προθεσμιας",
      "παραταση χρονου",
      "extension of time",
      "παραταση της προθεσμιας",
      "παρατασισ προθεσμιασ",
      "επεκταση του χρονου"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_002",
    "label": "ειδοποίηση",
    "aliases": [
      "ειδοποίηση εφεσίβλητου",
      "ειδοποιηση εφεσιβλητου",
      "ειδοποιηση εφεσιβλητων",
      "notice to respondent"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_003",
    "label": "ενδιάμεση",
    "aliases": [
      "ενδιάμεση αίτηση",
      "ενδιαμεση αιτηση",
      "interim application",
      "interlocutory application",
      "ενδιαμεσο διαταγμα"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_004",
    "label": "άδεια",
    "aliases": [
      "άδεια καταχώρισης",
      "αδεια καταχωρισης",
      "αδεια καταχωρησης",
      "leave to file",
      "αδεια εφεσης",
      "leave to appeal",
      "αδεια για καταχωριση",
      "άδεια χρήσης λόγω κωλύματος",
      "αδεια χρησησ λογω κωλυματοσ",
      "licence by estoppel",
      "συμβατικη αδεια χρησησ",
      "inferred from the conduct of the parties",
      "εξυπακουομενη συμφωνια",
      "inferred from conduct of the parties"
    ],
    "type": "principle"
  },
  {
    "id": "elite_005",
    "label": "έξοδα",
    "aliases": [
      "δικαστικά έξοδα",
      "δικαστικα εξοδα",
      "εξοδα της δικης",
      "εξοδα της εφεσης",
      "εξοδα της αιτησης",
      "order for costs",
      "επιδικαζονται εξοδα"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_006",
    "label": "παραγραφή",
    "aliases": [
      "παραγραφή",
      "παραγραφη",
      "limitation",
      "προθεσμια παραγραφης",
      "time-barred",
      "time barred",
      "statute-barred",
      "period of prescription",
      "παραγραφή ποινικών αδικημάτων",
      "παραγραφη ποινικων αδικηματων",
      "τα αδικηματα δεν ειχαν παραγραφει",
      "χρονικο οριο διωξησ",
      "time barred criminal offences",
      "limitation of offences"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_007",
    "label": "τροποποίηση",
    "aliases": [
      "τροποποίηση δικογράφου",
      "τροποποιηση δικογραφου",
      "τροποποιηση εκθεσης",
      "amendment of pleadings",
      "leave to amend",
      "amend the statement of defence",
      "μονομερής τροποποίηση μισθοδοσίας",
      "μονομερησ τροποποιηση μισθοδοσιασ",
      "αυθαιρετη τροποποιηση ουσιωδουσ ορου",
      "unilateral salary change",
      "fundamental term of employment"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_008",
    "label": "παραμερισμός",
    "aliases": [
      "παραμερισμός απόφασης",
      "παραμερισμος",
      "setting aside",
      "παραμερισμος αποφασης",
      "set aside",
      "παραμερισμός τελεσίδικης απόφασης",
      "παραμερισμοσ τελεσιδικησ αποφασησ",
      "παραμερισμοσ δεσμευτικησ αποφασησ",
      "set aside final judgment",
      "binding decision",
      "δεσμευτικη αποφαση του αρμοδιου δευτεροβαθμιου"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_009",
    "label": "απόρριψη",
    "aliases": [
      "απόρριψη λόγω μη προώθησης",
      "μη προωθηση",
      "want of prosecution",
      "απορριψη λογω μη προωθησης"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_010",
    "label": "ένσταση",
    "aliases": [
      "προδικαστική ένσταση",
      "προδικαστικη ενσταση",
      "preliminary objection"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_011",
    "label": "δικαιοδοσία",
    "aliases": [
      "δικαιοδοσία",
      "δικαιοδοσια",
      "jurisdiction",
      "ελλειψη δικαιοδοσιας",
      "υπερβαση δικαιοδοσιας",
      "δικαιοδοσία ενοικιοστασίου",
      "δικαστηριο ελεγχου ενοικιασεων",
      "δικαιοδοσια ενοικιοστασιου",
      "rent control court jurisdiction",
      "δεν ειχε αρμοδιοτητα η δικαιοδοσια"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_012",
    "label": "εκτέλεση",
    "aliases": [
      "εκτέλεση απόφασης",
      "εκτελεση αποφασης",
      "execution of judgment",
      "execution of a judgment",
      "αναγκαστικη εκτελεση",
      "ενταλμα κατασχεσης κινητων",
      "ειδική εκτέλεση",
      "ειδικη εκτελεση",
      "specific performance",
      "εκτέλεση Ευρωπαϊκού Εντάλματος Σύλληψης",
      "εκτελεση του ευρωπαϊκου ενταλματοσ συλληψησ",
      "εκτελεση του εεσ",
      "european arrest warrant",
      "eaw",
      "ευρωπαϊκο ενταλμα συλληψησ",
      "ειδική εκτέλεση πώλησης μετοχών",
      "ειδικη εκτελεση συμβασησ",
      "πωληση μετοχων",
      "specific performance of share sale",
      "διαταγμα ειδικησ εκτελεσησ",
      "ειδική εκτέλεση σύμβασης πώλησης μετοχών",
      "ειδικη εκτελεση τησ συμβασησ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_013",
    "label": "προσωρινό",
    "aliases": [
      "προσωρινό διάταγμα",
      "προσωρινο διαταγμα",
      "interim order",
      "παρεμπιπτον διαταγμα",
      "injunction",
      "απαγορευτικο διαταγμα"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_014",
    "label": "συντηρητικό",
    "aliases": [
      "συντηρητικό διάταγμα",
      "συντηρητικο διαταγμα",
      "συντηρητικα διαταγματα",
      "conservatory order"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_015",
    "label": "απόδειξη",
    "aliases": [
      "απόδειξη εκ πρώτης όψεως",
      "εκ πρωτης οψεως",
      "prima facie",
      "συμπεριφορά διαδίκων ως απόδειξη σύμβασης",
      "συμπεριφορα των διαδικων",
      "inferred from the conduct of the parties",
      "εξυπακουομενη συμφωνια",
      "implied agreement",
      "no case to answer"
    ],
    "type": "principle"
  },
  {
    "id": "elite_016",
    "label": "αναστολή",
    "aliases": [
      "αναστολή διαδικασίας",
      "αναστολη διαδικασιας",
      "stay of proceedings",
      "αναστολή εκτέλεσης",
      "αναστολη εκτελεσης",
      "stay of execution",
      "αναστολή ποινής",
      "αναστολη ποινης",
      "ποινη με αναστολη",
      "suspended sentence",
      "αναστολή ποινικής δίωξης",
      "ποινικη διωξη ανασταληκε",
      "αναστολη ποινικησ διωξησ",
      "nolle prosequi",
      "η διωξη ανασταληκε απο τον γενικο εισαγγελεα"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_017",
    "label": "αναβολή",
    "aliases": [
      "αναβολή",
      "αναβολη",
      "adjournment"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_018",
    "label": "συνένωση",
    "aliases": [
      "συνένωση αγωγών",
      "συνενωση αγωγων",
      "consolidation of actions",
      "consolidated actions",
      "συνεκδικαση"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_019",
    "label": "ανταγωγή",
    "aliases": [
      "ανταγωγή",
      "ανταγωγη",
      "counterclaim"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_020",
    "label": "τριτοδιάδικος",
    "aliases": [
      "τριτοδιάδικος",
      "τριτοδιαδικος",
      "third party notice",
      "ειδοποιηση τριτοδιαδικου"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_021",
    "label": "επίδοση",
    "aliases": [
      "επίδοση",
      "επιδοση",
      "service of process",
      "υποκαταστατη επιδοση",
      "substituted service"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_022",
    "label": "αποκάλυψη",
    "aliases": [
      "αποκάλυψη εγγράφων",
      "αποκαλυψη εγγραφων",
      "discovery of documents",
      "ενορκη αποκαλυψη",
      "μη αποκάλυψη ουσιωδών γεγονότων",
      "μη αποκαλυψη ουσιωδων γεγονοτων",
      "αποκρυψη ουσιαστικων γεγονοτων",
      "material non-disclosure",
      "πληρης αποκαλυψη",
      "full and frank disclosure",
      "υψιστη πιστη",
      "αποκάλυψη μαρτυρικού υλικού",
      "αποκαλυψη μαρτυρικου υλικου",
      "disclosure of prosecution material",
      "παραδοση εγγραφων και τεκμηριων",
      "material προς την υπερασπιση",
      "αποκάλυψη μαρτυρικού υλικού και δίκαιη δίκη",
      "ισοτητα των οπλων",
      "fair trial",
      "prosecution disclosure",
      "υπερασπιση"
    ],
    "type": "principle"
  },
  {
    "id": "elite_023",
    "label": "αντεξέταση",
    "aliases": [
      "αντεξέταση",
      "αντεξεταση",
      "cross examination",
      "cross-examination",
      "αντεξεταση μαρτυρα"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_024",
    "label": "σύλληψη",
    "aliases": [
      "ένταλμα σύλληψης",
      "ενταλμα συλληψης",
      "arrest warrant",
      "σύλληψη πλοίου",
      "συλληψη πλοιου",
      "arrest of ship",
      "action in rem",
      "αγωγη in rem"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_025",
    "label": "έρευνας",
    "aliases": [
      "ένταλμα έρευνας",
      "ενταλμα ερευνας",
      "search warrant"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_026",
    "label": "εκκρεμοδικία",
    "aliases": [
      "εκκρεμοδικία",
      "εκκρεμοδικια",
      "lis alibi pendens"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_027",
    "label": "παραπομπή",
    "aliases": [
      "παραπομπή",
      "παραπομπη",
      "referral",
      "committal"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_028",
    "label": "πτώχευση",
    "aliases": [
      "πτώχευση",
      "πτωχευση",
      "bankruptcy",
      "πτωχευτικο διαταγμα"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_029",
    "label": "εκκαθάριση",
    "aliases": [
      "εκκαθάριση εταιρείας",
      "εκκαθαριση",
      "winding up",
      "liquidation",
      "διορισμος εκκαθαριστη",
      "εκκαθάριση εξόδων",
      "εκκαθαριση εξοδων",
      "taxation of costs",
      "υπολογιστουν απο τον πρωτοκολλητη",
      "assessed by the registrar"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_030",
    "label": "διάταγμα",
    "aliases": [
      "διάταγμα Anton Piller",
      "διαταγμα anton piller",
      "anton piller order",
      "search order",
      "διάταγμα Mareva",
      "διαταγμα mareva",
      "mareva injunction",
      "freezing order",
      "παγοποιηση περιουσιακων",
      "διάταγμα Norwich Pharmacal",
      "διαταγμα norwich pharmacal",
      "norwich pharmacal order"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_031",
    "label": "ασυλία",
    "aliases": [
      "προνόμιο/ασυλία",
      "ασυλια",
      "privilege",
      "immunity"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_032",
    "label": "διαιτησία",
    "aliases": [
      "διαιτησία",
      "διαιτησια",
      "arbitration",
      "διαιτητικη αποφαση"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_033",
    "label": "διαμεσολάβηση",
    "aliases": [
      "διαμεσολάβηση",
      "διαμεσολαβηση",
      "mediation"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_034",
    "label": "κατάσχεση",
    "aliases": [
      "κατάσχεση εις χείρας τρίτου",
      "κατασχεση εις χειρας τριτου",
      "garnishee order",
      "μεσεγγυηση",
      "κατασχεση εισ χειρασ τριτου",
      "διαταγμα κατασχεσησ εισ χειρασ τριτου",
      "τριτοφειλετη"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_035",
    "label": "παρέμβαση",
    "aliases": [
      "παρέμβαση",
      "παρεμβαση",
      "intervention",
      "joinder",
      "leave to intervene"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_036",
    "label": "συνοπτική",
    "aliases": [
      "συνοπτική απόφαση",
      "συνοπτικη αποφαση",
      "summary judgment"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_037",
    "label": "έκθεση",
    "aliases": [
      "έκθεση απαίτησης",
      "εκθεση απαιτησης",
      "statement of claim",
      "έκθεση υπεράσπισης",
      "εκθεση υπερασπισης",
      "statement of defence"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_038",
    "label": "καταφρόνηση",
    "aliases": [
      "καταφρόνηση δικαστηρίου",
      "καταφρονηση δικαστηριου",
      "contempt of court",
      "παρακοη διαταγματος"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_039",
    "label": "λεπτομέρειες",
    "aliases": [
      "περαιτέρω λεπτομέρειες",
      "περαιτερω λεπτομερειες",
      "further and better particulars"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_040",
    "label": "διαγραφή",
    "aliases": [
      "διαγραφή δικογράφου",
      "διαγραφη δικογραφου",
      "striking out of pleadings"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_041",
    "label": "εγγύηση",
    "aliases": [
      "εγγύηση εξόδων",
      "εγγυηση εξοδων",
      "security for costs",
      "εγγύηση (bail)",
      "προσωποκρατηση",
      "ορους κρατησης",
      "bail"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_042",
    "label": "οδηγίες",
    "aliases": [
      "κλήση για οδηγίες",
      "κληση για οδηγιες",
      "summons for directions"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_043",
    "label": "διόρθωση",
    "aliases": [
      "διόρθωση σφάλματος",
      "διορθωση σφαλματος",
      "slip rule",
      "correction of error",
      "διόρθωση κτηματικού μητρώου",
      "διορθωση κτηματικου μητρωου",
      "ακυρωση εγγραφης"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_044",
    "label": "ερήμην",
    "aliases": [
      "ερήμην απόφαση",
      "ερημην αποφαση",
      "default judgment",
      "παραμερισμος αποφασης ερημην"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_045",
    "label": "πρόσθετοι",
    "aliases": [
      "πρόσθετοι λόγοι έφεσης",
      "προσθετοι λογοι εφεσης",
      "additional grounds of appeal"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_046",
    "label": "αντέφεση",
    "aliases": [
      "αντέφεση",
      "αντεφεση",
      "cross-appeal",
      "cross appeal"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_047",
    "label": "ένταλμα",
    "aliases": [
      "ένταλμα certiorari",
      "ενταλμα certiorari",
      "certiorari",
      "σερτιοραρι",
      "διαταγματος σερτιοραρι",
      "ένταλμα mandamus",
      "ενταλμα mandamus",
      "mandamus",
      "μανταμους",
      "ένταλμα prohibition",
      "ενταλμα prohibition",
      "prohibition",
      "αίτηση άδειας προνομιακού εντάλματος",
      "αιτηση για χορηγηση αδειασ",
      "αδεια για καταχωριση αιτησησ",
      "leave to apply for prerogative writ",
      "παραχωρηση αδειασ για την καταχωριση αιτησησ"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_048",
    "label": "κατηγορητήριο",
    "aliases": [
      "κατηγορητήριο",
      "κατηγορητηριο",
      "charge sheet",
      "indictment",
      "πολλαπλό κατηγορητήριο",
      "πολλεσ κατηγοριεσ",
      "σωρεια αδικηματων",
      "multiple counts",
      "33 στο συνολο"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_049",
    "label": "προανάκριση",
    "aliases": [
      "προανάκριση",
      "προανακριση",
      "preliminary inquiry"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_050",
    "label": "απαγγελία",
    "aliases": [
      "απαγγελία απόφασης",
      "απαγγελια αποφασης",
      "delivery of judgment",
      "δοθεισα αυθημερον"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_051",
    "label": "προθεσμία",
    "aliases": [
      "προθεσμία προνομιακών ενταλμάτων",
      "45 ημερων",
      "σαρανταπεντε ημερων",
      "εξαιρετικες περιστασεις που παρεμποδισαν"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_052",
    "label": "μέσο",
    "aliases": [
      "εναλλακτικό ένδικο μέσο",
      "εναλλακτικο ενδικο μεσο",
      "υπαρξη δικαιωματος εφεσης",
      "alternative remedy"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_053",
    "label": "συζητήσιμο",
    "aliases": [
      "συζητήσιμο θέμα",
      "συζητησιμο θεμα",
      "συζητησιμη υποθεση",
      "arguable case"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_054",
    "label": "εντός",
    "aliases": [
      "δίκη εντός δίκης",
      "δικη εντος δικης",
      "voir dire",
      "θεληματικοτητα καταθεσης"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_055",
    "label": "επανεκδίκαση",
    "aliases": [
      "επανεκδίκαση",
      "επανεκδικαση",
      "retrial",
      "new trial"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_056",
    "label": "κράτηση",
    "aliases": [
      "κράτηση υποδίκου",
      "κρατηση υποδικου",
      "υπο κρατηση μεχρι την εκδικαση",
      "διαταγματος κρατησης",
      "εφεση εναντιον διαταγματος κρατησης",
      "νόμιμη κράτηση αλλοδαπού",
      "νομιμη κρατηση",
      "παρανομη κρατηση",
      "immigration detention",
      "ευλογη προοπτικη απομακρυνσησ",
      "due diligence"
    ],
    "type": "principle"
  },
  {
    "id": "elite_057",
    "label": "ακυρώσεως",
    "aliases": [
      "λόγοι ακυρώσεως",
      "λογοι ακυρωσεως",
      "λογοι ακυρωσης",
      "λογους ακυρωσεως"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_058",
    "label": "σχέδιο",
    "aliases": [
      "σχέδιο υπηρεσίας",
      "σχεδιο υπηρεσιας",
      "σχεδια υπηρεσιας",
      "σχεδιου υπηρεσιας"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_059",
    "label": "διττό",
    "aliases": [
      "διττό αξιόποινο",
      "διττο αξιοποινο",
      "double criminality",
      "διττό αξιόποινο ΕΕΣ",
      "ελεγχοσ διττου αξιοποινου",
      "διττό αξιόποινο στο ΕΕΣ",
      "eaw",
      "ευρωπαϊκο ενταλμα συλληψησ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_060",
    "label": "κανόνας",
    "aliases": [
      "κανόνας ειδικότητας",
      "κανονας ειδικοτητας",
      "specialty rule",
      "κανόνας ειδικότητας ΕΕΣ",
      "κανονασ ειδικοτητασ",
      "principle of speciality",
      "εκζητουμενοσ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_061",
    "label": "διαβεβαιώσεις",
    "aliases": [
      "διπλωματικές διαβεβαιώσεις",
      "διπλωματικες διαβεβαιωσεις",
      "diplomatic assurances",
      "διαβεβαιωσεις"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_062",
    "label": "διάρκεια",
    "aliases": [
      "διάρκεια κράτησης",
      "διαρκεια κρατησης",
      "ευλογη προοπτικη απομακρυνσης",
      "δεουσα επιμελεια"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_063",
    "label": "διατάγματα",
    "aliases": [
      "διατάγματα κράτησης και απέλασης",
      "διαταγμα απελασης",
      "διαταγμα κρατησης",
      "deportation order",
      "διαταγματα κρατησης και απελασης"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_064",
    "label": "χρησικτησία",
    "aliases": [
      "χρησικτησία",
      "χρησικτησια",
      "εχθρικη κατοχη",
      "adverse possession"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_065",
    "label": "απαλλοτρίωση",
    "aliases": [
      "αναγκαστική απαλλοτρίωση",
      "απαλλοτριωση",
      "compulsory acquisition",
      "επιταξη"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_066",
    "label": "μέριμνα",
    "aliases": [
      "γονική μέριμνα/φύλαξη",
      "γονικη μεριμνα",
      "φυλαξη ανηλικου",
      "custody"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_067",
    "label": "διατροφή",
    "aliases": [
      "διατροφή",
      "διατροφη",
      "διατροφης ανηλικου"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_068",
    "label": "υιοθεσία",
    "aliases": [
      "υιοθεσία",
      "υιοθεσια",
      "adoption"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_069",
    "label": "τερματισμός",
    "aliases": [
      "τερματισμός απασχόλησης",
      "τερματισμος απασχολησης",
      "unfair dismissal",
      "wrongful dismissal",
      "παρανομος τερματισμος"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_070",
    "label": "πλεονασμός",
    "aliases": [
      "πλεονασμός",
      "πλεονασμος",
      "redundancy",
      "πλεοναζον προσωπικο"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_071",
    "label": "καταπίεση",
    "aliases": [
      "καταπίεση μειοψηφίας",
      "καταπιεση μειοψηφιας",
      "minority oppression"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_072",
    "label": "παράγωγη",
    "aliases": [
      "παράγωγη αγωγή",
      "παραγωγη αγωγη",
      "derivative action"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_073",
    "label": "ευχέρεια",
    "aliases": [
      "διακριτική ευχέρεια",
      "διακριτικη ευχερεια",
      "διακριτικησ ευχερειασ",
      "διακριτικη εξουσια",
      "judicial discretion",
      "διακριτικη ευχερεια του δικαστηριου"
    ],
    "type": "principle"
  },
  {
    "id": "elite_074",
    "label": "νομολογία",
    "aliases": [
      "πάγια νομολογία",
      "παγια νομολογια",
      "settled case law",
      "well established principle",
      "παγια αρχη",
      "διαχρονικα αναλλοιωτες αρχες"
    ],
    "type": "principle"
  },
  {
    "id": "elite_075",
    "label": "δίκαιη",
    "aliases": [
      "δίκαιη δίκη",
      "δικαιη δικη",
      "fair trial",
      "δικαιωμα σε δικαιη δικη"
    ],
    "type": "principle"
  },
  {
    "id": "elite_076",
    "label": "ερμηνεία",
    "aliases": [
      "ερμηνεία διατάξεων",
      "ερμηνεια διαταξεων",
      "ερμηνεια νομου",
      "statutory interpretation",
      "ερμηνεια του νομου",
      "ερμηνεία φορολογικών νόμων",
      "ερμηνεια φορολογικων νομων",
      "φυσικη και συνηθη ερμηνεια",
      "tax statutes interpretation",
      "λεκτικο ειναι σαφεσ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_077",
    "label": "βάρος",
    "aliases": [
      "βάρος απόδειξης",
      "βαρος αποδειξης",
      "burden of proof",
      "αποδεικτικο βαρος",
      "βαρος αποδειξεως",
      "onus of proof",
      "βάρος απόδειξης εργοδοτούμενου",
      "βαροσ αποδειξησ εργοδοτουμενου",
      "μαχητο τεκμηριο του αρθρου 7(2)",
      "employee bears burden",
      "απεσεισε το αποδεικτικο βαροσ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_078",
    "label": "πέραν",
    "aliases": [
      "πέραν λογικής αμφιβολίας",
      "περαν πασης λογικης αμφιβολιας",
      "beyond reasonable doubt",
      "περαν λογικης αμφιβολιας"
    ],
    "type": "principle"
  },
  {
    "id": "elite_079",
    "label": "σκοπός",
    "aliases": [
      "κοινός σκοπός",
      "κοινος σκοπος",
      "common purpose",
      "joint enterprise",
      "κοινη προθεση",
      "πρωταρχικός σκοπός ΚΠολΔ",
      "πρωταρχικος σκοπος",
      "overriding objective",
      "σκοπός δίωξης στο ΕΕΣ",
      "σκοποσ διωξησ",
      "for the purpose of prosecution",
      "προοριζεται για ποινικη διωξη",
      "prosecution purpose"
    ],
    "type": "principle"
  },
  {
    "id": "elite_080",
    "label": "δόλος",
    "aliases": [
      "δόλος",
      "δολος",
      "mens rea",
      "εκ προθεσεως",
      "fraud",
      "fraudulent",
      "collusion",
      "collusive",
      "απατη",
      "συμπαιγνια"
    ],
    "type": "principle"
  },
  {
    "id": "elite_081",
    "label": "αμέλεια",
    "aliases": [
      "αμέλεια",
      "αμελεια",
      "negligence",
      "αμελειαν",
      "συντρέχουσα αμέλεια",
      "συντρεχουσα αμελεια",
      "συντρεχουσαν αμελειαν",
      "συνυπαιτιοτητα",
      "contributory negligence"
    ],
    "type": "principle"
  },
  {
    "id": "elite_082",
    "label": "καθήκον",
    "aliases": [
      "καθήκον επιμέλειας",
      "καθηκον επιμελειας",
      "duty of care"
    ],
    "type": "principle"
  },
  {
    "id": "elite_083",
    "label": "δικαιοσύνη",
    "aliases": [
      "φυσική δικαιοσύνη",
      "φυσικη δικαιοσυνη",
      "φυσικησ δικαιοσυνησ",
      "κανονων της φυσικης δικαιοσυνης",
      "natural justice",
      "δικαιωμα ακροασης",
      "audi alteram partem"
    ],
    "type": "principle"
  },
  {
    "id": "elite_084",
    "label": "δεδικασμένο",
    "aliases": [
      "δεδικασμένο",
      "δεδικασμενο",
      "res judicata"
    ],
    "type": "principle"
  },
  {
    "id": "elite_085",
    "label": "αναλογικότητα",
    "aliases": [
      "αναλογικότητα",
      "αρχη της αναλογικοτητας",
      "αναλογικοτητα",
      "proportionality"
    ],
    "type": "principle"
  },
  {
    "id": "elite_086",
    "label": "πίστη",
    "aliases": [
      "καλή πίστη",
      "καλη πιστη",
      "good faith",
      "bona fide"
    ],
    "type": "principle"
  },
  {
    "id": "elite_087",
    "label": "δέουσα",
    "aliases": [
      "δέουσα έρευνα",
      "δεουσα ερευνα",
      "δεουσας ερευνας",
      "ελλειψη δεουσας ερευνας",
      "χωρις τη δεουσα ερευνα",
      "due inquiry",
      "επαρκης ερευνα"
    ],
    "type": "principle"
  },
  {
    "id": "elite_088",
    "label": "αιτιολογία",
    "aliases": [
      "αιτιολογία",
      "ελλιπης αιτιολογια",
      "ελλειψη αιτιολογιας",
      "αναιτιολογητη",
      "αιτιολογια της αποφασης",
      "inadequate reasoning"
    ],
    "type": "principle"
  },
  {
    "id": "elite_089",
    "label": "ισότητα",
    "aliases": [
      "ισότητα των όπλων",
      "ισοτητα των οπλων",
      "equality of arms",
      "ισότητα στη φορολογία",
      "ισοτητα στη φορολογια",
      "αρθρο 24",
      "αρθρο 28",
      "equal treatment in taxation",
      "αρχη τησ ισοτητασ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_090",
    "label": "γνώση",
    "aliases": [
      "δικαστική γνώση",
      "δικαστικη γνωση",
      "judicial notice",
      "δικαστικην γνωσιν"
    ],
    "type": "principle"
  },
  {
    "id": "elite_091",
    "label": "μαρτυρία",
    "aliases": [
      "εξ ακοής μαρτυρία",
      "εξ ακοης μαρτυρια",
      "hearsay evidence",
      "εξ ακοης μαρτυριας",
      "περιστατική μαρτυρία",
      "περιστατικη μαρτυρια",
      "circumstantial evidence",
      "ενισχυτική μαρτυρία",
      "ενισχυτικη μαρτυρια",
      "corroboration",
      "ενισχυτική μαρτυρία σε σεξουαλικά αδικήματα",
      "σεξουαλικη εκμεταλλευση ανηλικου",
      "απουσια ενισχυτικησ μαρτυριασ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_092",
    "label": "κώλυμα",
    "aliases": [
      "κώλυμα (estoppel)",
      "κωλυμα",
      "estoppel",
      "promissory estoppel"
    ],
    "type": "principle"
  },
  {
    "id": "elite_093",
    "label": "εμπιστοσύνη",
    "aliases": [
      "δικαιολογημένη εμπιστοσύνη",
      "δικαιολογημενη εμπιστοσυνη",
      "legitimate expectation",
      "αμοιβαία εμπιστοσύνη",
      "αμοιβαια εμπιστοσυνη",
      "mutual trust",
      "αμοιβαια αναγνωριση",
      "mutual recognition"
    ],
    "type": "principle"
  },
  {
    "id": "elite_094",
    "label": "αρχή",
    "aliases": [
      "αρχή της νομιμότητας",
      "αρχη της νομιμοτητας",
      "principle of legality",
      "αρχή συνολικότητας ποινής",
      "αρχη συνολικοτητασ",
      "totality principle",
      "συνολικη ποινη",
      "overall sentence",
      "συνολικοτητα τησ ποινησ",
      "αρχή αναλογικότητας στην ποινή",
      "αναλογικοτητα τησ ποινησ",
      "proportionality of sentence",
      "ποινη αναλογη",
      "βαρυτητα των αδικηματων",
      "αρχή συνολικότητας",
      "concurrent sentences",
      "ποινεσ συντρεχουν",
      "οι ποινεσ συντρεχουν"
    ],
    "type": "principle"
  },
  {
    "id": "elite_095",
    "label": "επιείκεια",
    "aliases": [
      "επιείκεια",
      "δικαιο της επιεικειας",
      "principles of equity",
      "επιεικεια"
    ],
    "type": "principle"
  },
  {
    "id": "elite_096",
    "label": "ανώτερη",
    "aliases": [
      "ανώτερη βία",
      "ανωτερη βια",
      "force majeure"
    ],
    "type": "principle"
  },
  {
    "id": "elite_097",
    "label": "ματαίωση",
    "aliases": [
      "ματαίωση συμβολαίου",
      "ματαιωση συμβολαιου",
      "frustration of contract"
    ],
    "type": "principle"
  },
  {
    "id": "elite_098",
    "label": "πλουτισμός",
    "aliases": [
      "αδικαιολόγητος πλουτισμός",
      "αδικαιολογητος πλουτισμος",
      "unjust enrichment"
    ],
    "type": "principle"
  },
  {
    "id": "elite_099",
    "label": "κατάχρηση",
    "aliases": [
      "κατάχρηση διαδικασίας",
      "καταχρηση διαδικασιας",
      "abuse of process",
      "καταχρηση δικαστικης διαδικασιας",
      "κατάχρηση εξουσίας",
      "καταχρηση εξουσιας",
      "υπερβαση εξουσιας",
      "καταχρησης η υπερβασης εξουσιας",
      "κατάχρηση διαδικασίας λόγω καθυστέρησης",
      "καταχρηση δικαστικησ διαδικασιασ",
      "μεγαλη καθυστερηση",
      "παραβιαση δικαιωματοσ δικαιησ δικησ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_100",
    "label": "άρση",
    "aliases": [
      "άρση εταιρικού πέπλου",
      "αρση εταιρικου πεπλου",
      "piercing the corporate veil",
      "lifting the corporate veil"
    ],
    "type": "principle"
  },
  {
    "id": "elite_101",
    "label": "διοίκηση",
    "aliases": [
      "χρηστή διοίκηση",
      "χρηστη διοικηση",
      "good administration"
    ],
    "type": "principle"
  },
  {
    "id": "elite_102",
    "label": "αμεροληψία",
    "aliases": [
      "αμεροληψία",
      "αμεροληψια",
      "μεροληψια",
      "προκαταληψη",
      "impartiality",
      "αρχη της αμεροληψιας",
      "nemo judex"
    ],
    "type": "principle"
  },
  {
    "id": "elite_103",
    "label": "αναδρομικότητα",
    "aliases": [
      "αναδρομικότητα",
      "αναδρομικοτητα",
      "retrospectivity",
      "retroactive effect"
    ],
    "type": "principle"
  },
  {
    "id": "elite_104",
    "label": "ευθύνη",
    "aliases": [
      "εκ προστηθέντος ευθύνη",
      "εκ προστηθεντος ευθυνη",
      "vicarious liability",
      "αυστηρή ευθύνη",
      "αυστηρη ευθυνη",
      "strict liability",
      "ποινική ευθύνη ανηλίκου",
      "ηλικια καταλογισμου ποινικησ ευθυνησ",
      "criminal responsibility of child",
      "δεν βρισκοταν σε ηλικια καταλογισμου"
    ],
    "type": "principle"
  },
  {
    "id": "elite_105",
    "label": "προβλεψιμότητα",
    "aliases": [
      "προβλεψιμότητα",
      "προβλεψιμοτητα",
      "foreseeability"
    ],
    "type": "principle"
  },
  {
    "id": "elite_106",
    "label": "μετριασμός",
    "aliases": [
      "μετριασμός ζημιών",
      "μετριασμος ζημιας",
      "μετριασμος ζημιων",
      "mitigation of damages"
    ],
    "type": "principle"
  },
  {
    "id": "elite_107",
    "label": "ύψος",
    "aliases": [
      "ύψος αποζημιώσεων",
      "υψος αποζημιωσεων",
      "quantum of damages"
    ],
    "type": "principle"
  },
  {
    "id": "elite_108",
    "label": "αποζημιώσεις",
    "aliases": [
      "τιμωρητικές αποζημιώσεις",
      "τιμωρητικες αποζημιωσεις",
      "παραδειγματικες αποζημιωσεις",
      "punitive damages",
      "exemplary damages",
      "γενικές αποζημιώσεις",
      "γενικες αποζημιωσεις",
      "general damages",
      "ειδικες αποζημιωσεις",
      "special damages"
    ],
    "type": "principle"
  },
  {
    "id": "elite_109",
    "label": "έννομο",
    "aliases": [
      "έννομο συμφέρον",
      "εννομο συμφερον",
      "locus standi"
    ],
    "type": "principle"
  },
  {
    "id": "elite_110",
    "label": "υπόθεση",
    "aliases": [
      "εκ πρώτης όψεως υπόθεση",
      "εκ πρωτης οψεως υποθεση",
      "prima facie case",
      "συζητήσιμη υπόθεση για άδεια",
      "συζητησιμη υποθεση",
      "arguable case",
      "εκ πρωτησ οψεωσ συζητησιμο ζητημα",
      "leave stage"
    ],
    "type": "principle"
  },
  {
    "id": "elite_111",
    "label": "ισοζύγιο",
    "aliases": [
      "ισοζύγιο πιθανοτήτων",
      "ισοζυγιο πιθανοτητων",
      "balance of probabilities",
      "preponderance of evidence"
    ],
    "type": "principle"
  },
  {
    "id": "elite_112",
    "label": "αθωότητα",
    "aliases": [
      "τεκμήριο αθωότητας",
      "τεκμηριο αθωοτητας",
      "presumption of innocence"
    ],
    "type": "principle"
  },
  {
    "id": "elite_113",
    "label": "νομιμότητα",
    "aliases": [
      "τεκμήριο νομιμότητας",
      "τεκμηριο νομιμοτητας",
      "presumption of legality",
      "τεκμηριο κανονικοτητας",
      "certiorari ελέγχει νομιμότητα όχι ορθότητα",
      "ελεγχος νομιμοτητασ και οχι ορθοτητασ",
      "δεν ενεργει ωσ εφετειο",
      "certiorari legality not merits",
      "not correctness"
    ],
    "type": "principle"
  },
  {
    "id": "elite_114",
    "label": "ελευθερία",
    "aliases": [
      "ελευθερία της έκφρασης",
      "ελευθερια της εκφρασης",
      "freedom of expression"
    ],
    "type": "principle"
  },
  {
    "id": "elite_115",
    "label": "δικαίωμα",
    "aliases": [
      "δικαίωμα ιδιοκτησίας",
      "δικαιωμα ιδιοκτησιας",
      "right to property",
      "δικαίωμα δίκης εντός ευλόγου χρόνου",
      "δικη εντοσ ευλογου χρονου",
      "δικαιωμα δικησ εντοσ ευλογου χρονου",
      "reasonable time",
      "εντοσ ευλογου χρονου"
    ],
    "type": "principle"
  },
  {
    "id": "elite_116",
    "label": "διάκριση",
    "aliases": [
      "διάκριση των εξουσιών",
      "διακριση των εξουσιων",
      "separation of powers"
    ],
    "type": "principle"
  },
  {
    "id": "elite_117",
    "label": "ανεξαρτησία",
    "aliases": [
      "ανεξαρτησία της δικαιοσύνης",
      "ανεξαρτησια δικαιοσυνης",
      "judicial independence"
    ],
    "type": "principle"
  },
  {
    "id": "elite_118",
    "label": "δημόσιο",
    "aliases": [
      "δημόσιο συμφέρον",
      "δημοσιο συμφερον",
      "δημοσιου συμφεροντος",
      "public interest"
    ],
    "type": "principle"
  },
  {
    "id": "elite_119",
    "label": "θεμελιώδη",
    "aliases": [
      "θεμελιώδη δικαιώματα",
      "θεμελιωδη δικαιωματα",
      "fundamental rights"
    ],
    "type": "principle"
  },
  {
    "id": "elite_120",
    "label": "αξιοπιστία",
    "aliases": [
      "όρια επέμβασης εφετείου στην αξιοπιστία",
      "αξιολογηση της αξιοπιστιας των μαρτυρων",
      "το εφετειο σπανια επεμβαινει",
      "εξ αντικειμενου ανυποστατα",
      "κατ εξοχην του πρωτοδικου δικαστηριου",
      "καθυστέρηση καταγγελίας και αξιοπιστία",
      "καθυστερηση υποβολησ τησ καταγγελιασ",
      "delay in complaint",
      "αξιολογηση τησ μαρτυριασ",
      "δικαιολογια για την καθυστερηση"
    ],
    "type": "principle"
  },
  {
    "id": "elite_121",
    "label": "έκδηλα",
    "aliases": [
      "έκδηλα υπερβολική ποινή",
      "εκδηλα υπερβολικη ποινη",
      "εκδηλα υπερβολικες ποινεσ",
      "εκδηλα ακρως υπερβολικες",
      "εκδηλα ακρως υπερβολικες ποινεσ",
      "εκδηλα ακρως υπερβολικη ποινη",
      "manifestly excessive sentence",
      "έκδηλα ανεπαρκής ποινή",
      "εκδηλα ανεπαρκης",
      "εκδηλα ανεπαρκεις",
      "εκδηλα ανεπαρκους",
      "εκδηλα ανεπαρκη",
      "manifestly inadequate",
      "ανεπαρκεια της ποινης",
      "σφαλμα αρχησ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_122",
    "label": "πράξη",
    "aliases": [
      "εκτελεστή διοικητική πράξη",
      "εκτελεστη διοικητικη πραξη",
      "βεβαιωτικη πραξη",
      "νεα ερευνα",
      "confirmatory act"
    ],
    "type": "principle"
  },
  {
    "id": "elite_123",
    "label": "φειδώ",
    "aliases": [
      "φειδώ προνομιακής δικαιοδοσίας",
      "ιδιαιτερη φειδω",
      "κατα προνομιο και οχι δικαιωματικα",
      "θεραπεια κατ εξαιρεση"
    ],
    "type": "principle"
  },
  {
    "id": "elite_124",
    "label": "έλεγχος",
    "aliases": [
      "έλεγχος νομιμότητας όχι ορθότητας",
      "δεν εξεταζεται η ορθοτητα",
      "ελεγχος νομιμοτητας",
      "δεν ενεργει ως εφετειο",
      "ακυρωτικός έλεγχος",
      "ακυρωτικος ελεγχος",
      "ακυρωτικη δικαιοδοσια",
      "ακυρωτικη αποφαση",
      "συμμορφωση με ακυρωτικη",
      "έλεγχος συνταγματικότητας μόνο παρεμπιπτόντως",
      "δεν ελεγχεται γενικα η συνταγματικοτητα",
      "εκταση που σχετιζεται με την εγκυροτητα τησ πραξησ",
      "incidental constitutional review",
      "αρθρο 146"
    ],
    "type": "principle"
  },
  {
    "id": "elite_125",
    "label": "έκδηλη",
    "aliases": [
      "έκδηλη νομική πλάνη",
      "εκδηλη νομικη πλανη",
      "error of law on the face",
      "νομικη πλανη",
      "έκδηλη υπεροχή",
      "εκδηλη υπεροχη",
      "εκδηλης υπεροχης",
      "έκδηλη πλάνη νόμου",
      "εκδηλη πλανη νομου",
      "face of the record"
    ],
    "type": "principle"
  },
  {
    "id": "elite_126",
    "label": "επιμέτρηση",
    "aliases": [
      "επιμέτρηση ποινής",
      "επιμετρηση ποινης",
      "επιμετρηση της ποινης",
      "εξατομικευση της ποινης",
      "ελαφρυντικα",
      "εμπρακτη μεταμελεια",
      "συντρεχουσες ποινες",
      "ποινης φυλακισης"
    ],
    "type": "principle"
  },
  {
    "id": "elite_127",
    "label": "πλάνη",
    "aliases": [
      "πλάνη περί τα πράγματα",
      "πλανη περι τα πραγματα",
      "πραγματικη πλανη",
      "πεπλανημενη",
      "πλανη περι το νομο"
    ],
    "type": "principle"
  },
  {
    "id": "elite_128",
    "label": "παράλειψη",
    "aliases": [
      "παράλειψη ουσιώδους τύπου",
      "παραλειψη ουσιωδους τυπου",
      "ουσιωδους τυπου διατεταγμενου",
      "mandamus για διοικητική παράλειψη",
      "ενταλμα mandamus",
      "mandamus administrative omission",
      "μανταμους"
    ],
    "type": "principle"
  },
  {
    "id": "elite_129",
    "label": "παραίτηση",
    "aliases": [
      "παραίτηση από δικαίωμα",
      "παραιτηση απο δικαιωμα",
      "waiver",
      "εξαναγκαστική παραίτηση λόγω ουσιώδους παραβίασης",
      "εξαναγκασμοσ σε παραιτηση",
      "constructive dismissal",
      "ουσιωδησ οροσ τησ εργασιακησ συμβασησ",
      "κλονιζε το θεμελιο τησ σχεσησ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_130",
    "label": "επανάνοιγμα",
    "aliases": [
      "επανάνοιγμα έφεσης",
      "επανανοιγμα εφεσης",
      "reopening appeal",
      "re-open the appeal",
      "reopen appeal",
      "μονομερης αιτηση για επανανοιγμα εφεσης"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_131",
    "label": "διαταγή",
    "aliases": [
      "διαταγή επανεκδίκασης",
      "διαταγη επανεκδικασησ",
      "διαταχθηκε επανεκδικαση",
      "διαταχθει επανεκδικαση",
      "order for retrial",
      "new trial ordered"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_132",
    "label": "συνεκδίκαση",
    "aliases": [
      "συνεκδίκαση εφέσεων",
      "συνεκδικαστηκαν",
      "συνεξεταστουν μαζι",
      "οι δυο εφεσεισ εξεταστουν μαζι",
      "consolidated appeals",
      "heard together"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_133",
    "label": "εμφάνιση",
    "aliases": [
      "αυτοπρόσωπη εμφάνιση",
      "αυτοπροσωπωσ",
      "αυτοπροσωπη υπερασπιση",
      "self represented",
      "appeared in person",
      "in person"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_134",
    "label": "ανταπαίτηση",
    "aliases": [
      "ανταπαίτηση",
      "ανταπαιτηση",
      "counterclaim",
      "η ανταπαιτηση απορριφθηκε"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_135",
    "label": "δέσμευση",
    "aliases": [
      "δέσμευση από προηγούμενη απόφαση",
      "δεσμευτικη αποφαση",
      "δεδικασμενο",
      "ηδη υπαρχει δεσμευτικη αποφαση",
      "bound by previous decision",
      "finality of litigation",
      "δέσμευση από δικογράφηση",
      "δεσμευση απο δικογραφηση",
      "εκτοσ τησ κυριωσ αιτησησ",
      "pleadings bind the parties",
      "bound by pleadings",
      "αλλη υποθεση και την ακολουθει στη μαρτυρια"
    ],
    "type": "principle"
  },
  {
    "id": "elite_136",
    "label": "έφεση",
    "aliases": [
      "έφεση κατά καταδίκης",
      "εφεση εναντιον καταδικησ",
      "εφεση κατα καταδικησ",
      "conviction appeal",
      "καταδικαστικη αποφαση",
      "προσβαλλει την καταδικη",
      "έφεση κατά ποινής",
      "εφεση κατα ποινησ",
      "εφεση εναντιον τησ ποινησ",
      "sentence appeal",
      "προσβαλλει την επιβληθεισα ποινη",
      "η ποινη προσβαλλεται",
      "αναθεωρητική έφεση",
      "αναθεωρητικη εφεση",
      "revisionary appeal",
      "administrative appeal",
      "προσβαλλομενη διοικητικη αποφαση"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_137",
    "label": "καθυστέρηση",
    "aliases": [
      "καθυστέρηση καταγγελίας",
      "καθυστερηση υποβολησ τησ καταγγελιασ",
      "καθυστερηση στην καταγγελια",
      "delay in complaint",
      "delayed complaint",
      "αιτιολογια για την καθυστερηση"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_138",
    "label": "ηλικία",
    "aliases": [
      "ηλικία ποινικής ευθύνης",
      "ηλικια καταλογισμου ποινικησ ευθυνησ",
      "ποινικη ευθυνη ανηλικου",
      "age of criminal responsibility",
      "δεν βρισκοταν σε ηλικια καταλογισμου"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_139",
    "label": "συντρέχουσες",
    "aliases": [
      "συντρέχουσες ποινές",
      "συντρεχουσεσ ποινεσ",
      "ποινεσ συντρεχουν",
      "concurrent sentences",
      "sentences run concurrently"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_140",
    "label": "αθώωση",
    "aliases": [
      "απαλλαγή μετά από αθώωση",
      "αθωωθηκε και απαλλαχθηκε",
      "αθωωση και απαλλαγη",
      "acquitted and discharged",
      "αθωωνεται και απαλλασσεται"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_141",
    "label": "ύλες",
    "aliases": [
      "εκρηκτικές ύλες",
      "εκρηκτικεσ υλεσ",
      "περι εκρηκτικων υλων",
      "explosive substances",
      "κατοχη εκρηκτικων"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_142",
    "label": "κλοπή",
    "aliases": [
      "κλοπή και κλεπταποδοχή",
      "κλοπη",
      "κλεπταποδοχη",
      "παρανομη κατοχη περιουσιασ",
      "stolen property",
      "receiving stolen goods"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_143",
    "label": "εκμετάλλευση",
    "aliases": [
      "σεξουαλική εκμετάλλευση ανηλίκου",
      "σεξουαλικη εκμεταλλευση ανηλικου",
      "σεξουαλικη εκμεταλλευση παιδιου",
      "ασεμνη επιθεση",
      "συνουσια με νεαρο",
      "sexual exploitation of minor"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_144",
    "label": "αξιολόγηση",
    "aliases": [
      "εσφαλμένη αξιολόγηση μαρτυρίας",
      "εσφαλμενη αξιολογηση τησ μαρτυριασ",
      "αξιολογηση μαρτυριασ",
      "credibility assessment",
      "wrong assessment of evidence"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_145",
    "label": "έλλειψη",
    "aliases": [
      "έλλειψη ενισχυτικής μαρτυρίας",
      "απουσια ενισχυτικησ μαρτυριασ",
      "χωρισ ενισχυτικη μαρτυρια",
      "lack of corroboration",
      "corroborative evidence"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_146",
    "label": "υπέρβαση",
    "aliases": [
      "υπέρβαση δικαιοδοσίας",
      "υπερβαση δικαιοδοσιασ",
      "υπερεβη την εξουσια",
      "excess of jurisdiction",
      "lack of jurisdiction",
      "στερειται δικαιοδοσιασ"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_147",
    "label": "θεραπεία",
    "aliases": [
      "εναλλακτική θεραπεία",
      "εναλλακτικη θεραπεια",
      "εναλλακτικο ενδικο μεσο",
      "alternative remedy",
      "υπαρξη δικαιωματοσ εφεσησ",
      "προνομιακό ένταλμα ως εξαιρετική θεραπεία",
      "θεραπεια κατ εξαιρεση",
      "κατα προνομιο και οχι δικαιωματικα",
      "ιδιαιτερη φειδω",
      "prerogative writ exceptional",
      "εναλλακτική θεραπεία αποκλείει προνομιακό ένταλμα",
      "δεν δικαιολογειται προνομιακο ενταλμα"
    ],
    "type": "principle"
  },
  {
    "id": "elite_148",
    "label": "αλλοδαπού",
    "aliases": [
      "habeas corpus αλλοδαπού",
      "habeas corpus",
      "παρανομη κρατηση αλλοδαπου",
      "κρατουνται στα αστυνομικα κρατητηρια",
      "immigration detention habeas"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_149",
    "label": "απομάκρυνση",
    "aliases": [
      "προοπτική απομάκρυνσης",
      "ευλογη προοπτικη απομακρυνσησ",
      "reasonable prospect of removal",
      "απομακρυνση απο τη δημοκρατια",
      "deportation removal prospect"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_150",
    "label": "επιμέλεια",
    "aliases": [
      "δέουσα επιμέλεια κράτησης",
      "δεουσα επιμελεια",
      "due diligence",
      "διαρκεια κρατησησ",
      "παραταση κρατησησ"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_151",
    "label": "εύλογος",
    "aliases": [
      "εύλογος χρόνος διοίκησης",
      "εντοσ ευλογου χρονου",
      "ευλογοσ χρονοσ διοικησησ",
      "reasonable time by administration",
      "καταστει δυνατη η εξεταση τησ αιτησησ"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_152",
    "label": "Άρθρο",
    "aliases": [
      "Άρθρο 146 προσφυγή",
      "αρθρο 146",
      "προσφυγη κατω απο το αρθρο 146",
      "recourse under article 146",
      "αναθεωρητικη εφεση"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_153",
    "label": "παράδοση",
    "aliases": [
      "παράδοση εκζητουμένου",
      "παραδοση του εκζητουμενου",
      "διαταξει την παραδοση",
      "surrender of the requested person",
      "εκζητουμενοσ",
      "παράδοση για σκοπούς ποινικής δίωξης",
      "σκοποσ ποινικησ διωξησ",
      "purpose of prosecution",
      "for prosecution"
    ],
    "type": "principle"
  },
  {
    "id": "elite_154",
    "label": "λόγος",
    "aliases": [
      "προαιρετικός λόγος μη εκτέλεσης ΕΕΣ",
      "προαιρετικοσ λογοσ μη εκτελεσησ",
      "optional ground for refusal",
      "optional non execution",
      "λογοι μη εκτελεσησ του εεσ"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_155",
    "label": "καταχώριση",
    "aliases": [
      "καταχώριση μεταβίβασης μετοχών",
      "καταχωριση μεταβιβασησ μετοχων",
      "μεταβιβαστικο εγγραφο",
      "μητρωο τησ εταιρειασ",
      "registration of transfer of shares",
      "Άρθρο 73 Κεφ.113 αφορά καταχώριση όχι εγκυρότητα σύμβασης",
      "αρθρο 73 του κεφ.113",
      "καταχωριση τησ μεταβιβασησ",
      "οχι τη συνομολογηση εγκυρησ συμφωνιασ",
      "registration not validity of share sale"
    ],
    "type": "principle"
  },
  {
    "id": "elite_156",
    "label": "σημείο",
    "aliases": [
      "νομικό σημείο εργατικής έφεσης",
      "νομικο σημειο",
      "εφεση εναντιον αποφασησ δικαστηριου εργατικων διαφορων",
      "point of law employment appeal"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_157",
    "label": "εξαναγκασμός",
    "aliases": [
      "εξαναγκασμός σε παραίτηση",
      "εξαναγκασμοσ σε παραιτηση",
      "constructive dismissal",
      "εξαναγκαστηκε σε παραιτηση",
      "κλονισε το θεμελιο τησ σχεσησ εργοδοτη εργοδοτουμενου"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_158",
    "label": "σχέση",
    "aliases": [
      "σχέση εργοδότη εργοδοτουμένου",
      "σχεση εργοδοτη εργοδοτουμενου",
      "σχεση εξαρτημενησ εργασιασ",
      "employer employee relationship",
      "control test"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_159",
    "label": "περιουσιακές",
    "aliases": [
      "περιουσιακές διαφορές συζύγων",
      "αιτηση περιουσιακων διαφορων",
      "οικογενειακο δικαστηριο",
      "συνεισφορα στην αγορα χωραφιου",
      "matrimonial property dispute"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_160",
    "label": "θέσμια",
    "aliases": [
      "θέσμια ενοικίαση",
      "θεσμιοσ ενοικιαστησ",
      "θεσμια ενοικιαση",
      "statutory tenant",
      "controlled premises",
      "ελεγχόμενη περιοχή",
      "θέσμια ενοικίαση προϋποθέτει λήξη πρώτης ενοικίασης",
      "ληξη η τερματισμοσ πρωτησ ενοικιασησ",
      "statutory tenancy",
      "rent control jurisdiction"
    ],
    "type": "principle"
  },
  {
    "id": "elite_161",
    "label": "ενοίκια",
    "aliases": [
      "καθυστερημένα ενοίκια",
      "καθυστερημενα ενοικια",
      "οφειλομενα ενοικια",
      "arrears of rent",
      "mesne profits",
      "ενδιαμεσα οφελη"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_162",
    "label": "φορολογία",
    "aliases": [
      "διπλή φορολογία",
      "διπλη φορολογια",
      "double taxation",
      "δυο φορολογιων",
      "φορολογια για τα εισοδηματα του 1978 και του 1979",
      "καταστρεπτική φορολογία",
      "καταστρεπτικη φορολογια",
      "απαγορευτικη φορολογια",
      "destructive taxation",
      "prohibitive taxation",
      "ιδιαιτερα επαχθησ",
      "αναδρομική φορολογία",
      "αναδρομικη φορολογια",
      "retroactive tax",
      "retrospective taxation",
      "αρθρο 24.3",
      "διπλή φορολογία δεν είναι αυτομάτως καταστρεπτική",
      "διπλη φορολογια δεν συνιστα απο μονη τησ",
      "destructive or prohibitive taxation",
      "δυο διαφορετικα εισοδηματα",
      "δεν αποτελει διπλη φορολογια"
    ],
    "type": "principle"
  },
  {
    "id": "elite_163",
    "label": "συνταγματικότητα",
    "aliases": [
      "συνταγματικότητα φορολογικού νόμου",
      "συνταγματικοτητα του αρθρου",
      "αντισυνταγματικο",
      "presumption of constitutionality",
      "τεκμηριο συνταγματικοτητασ",
      "φορολογικοσ νομοσ"
    ],
    "type": "procedure"
  },
  {
    "id": "elite_164",
    "label": "τελικότητα",
    "aliases": [
      "τελικότητα της δικαστικής κρίσης",
      "τελικοτητα τησ δικαστικησ κρισησ",
      "finality of litigation",
      "δεσμευτικη αποφαση",
      "δεν επιτρεπεται επανανοιγμα",
      "res judicata"
    ],
    "type": "principle"
  },
  {
    "id": "elite_165",
    "label": "όρια",
    "aliases": [
      "όρια επέμβασης εφετείου σε πραγματικά ευρήματα",
      "το εφετειο δεν επεμβαινει ευκολα",
      "πραγματικα ευρηματα",
      "αξιοπιστια μαρτυρων",
      "findings of fact",
      "credibility findings"
    ],
    "type": "principle"
  },
  {
    "id": "elite_166",
    "label": "αιτιολογημένη",
    "aliases": [
      "αιτιολογημένη απόφαση",
      "αιτιολογημενη αποφαση",
      "εμπεριστατωμενη αναλυση και αιτιολογια",
      "reasoned judgment",
      "duty to give reasons"
    ],
    "type": "principle"
  },
  {
    "id": "elite_167",
    "label": "διοικητικής",
    "aliases": [
      "mandamus κατά διοικητικής παράλειψης",
      "mandamus",
      "ενταλμα mandamus",
      "μανταμους"
    ],
    "type": "principle"
  },
  {
    "id": "elite_168",
    "label": "νόμων",
    "aliases": [
      "τεκμήριο συνταγματικότητας νόμων",
      "τεκμηριο τησ συνταγματικοτητασ",
      "presumption of constitutionality",
      "περαν πασησ λογικησ αμφιβολιασ",
      "νομοσ ειναι συνταγματικοσ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_169",
    "label": "αμοιβαία",
    "aliases": [
      "αμοιβαία αναγνώριση στο ΕΕΣ",
      "αμοιβαια αναγνωριση",
      "mutual recognition",
      "ευρωπαϊκο ενταλμα συλληψησ",
      "εκτελεση του εεσ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_170",
    "label": "εργοδότη",
    "aliases": [
      "κριτήριο ελέγχου εργοδότη εργοδοτουμένου",
      "κριτηριο τησ σχεσησ εργοδοτη",
      "κριτηριο του ελεγχου",
      "control test",
      "σχεση εξαρτημενησ εργασιασ"
    ],
    "type": "principle"
  },
  {
    "id": "elite_171",
    "label": "περιουσιακή",
    "aliases": [
      "περιουσιακή συνεισφορά συζύγου",
      "συνεισφορα στην αγορα",
      "περιουσιακεσ διαφορεσ",
      "οικογενειακο δικαστηριο",
      "matrimonial property contribution",
      "κατα νομοθετικο τεκμηριο"
    ],
    "type": "principle"
  },
  {
    "id": "elite_172",
    "label": "υποχρέωση",
    "aliases": [
      "φορολογική υποχρέωση γεννάται με την απόκτηση εισοδήματος",
      "υποχρεωση δημιουργειται κατα το χρονο αποκτησησ",
      "time income is earned",
      "chargeable income",
      "φοροσ επιβαλλεται"
    ],
    "type": "principle"
  },
  {
    "id": "elite_173",
    "label": "διάταξη",
    "aliases": [
      "μεταβατική φορολογική διάταξη",
      "μεταβατικη διαταξη",
      "αρθρο 54",
      "διατηρησε την προηγουμενη νομοθεσια",
      "transitional tax provision"
    ],
    "type": "principle"
  }
];

export const ELITE_LEGAL_CONCEPT_COUNT = ELITE_LEGAL_CONCEPTS.length;
