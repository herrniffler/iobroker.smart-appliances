# Smart Appliances Adapter für ioBroker

Intelligenter Großgeräte-Scheduler mit Tibber-Energiepreis-Optimierung (minutengenaue Planung, automatische Starts, flexible manuelle Anpassungen)

## Inhalt
- [Funktionen](#funktionen)
- [Architekturüberblick](#architekturüberblick)
- [Installation](#installation)
- [Konfiguration](#konfiguration)
- [Gerätespezifika](#gerätespezifika)
- [Preisoptimierung (Algorithmus)](#preisoptimierung-algorithmus)
- [States](#states)
- [sendTo-API](#sendto-api)
- [Manuelle Eingriffe / Overrides](#manuelle-eingriffe--overrides)
- [Benachrichtigungen](#benachrichtigungen)
- [ToDoist-Integration](#todoist-integration)
- [Beispiele](#beispiele)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)
- [License](#license)

## Funktionen

- **Minutengenaue Tibber-Optimierung**: Nicht mehr nur ganze Stunden – es wird das günstigste zusammenhängende Minutenfenster gesucht.
- **Generisches Scheduling** (alle Geräte, die es aktivieren): `startTime` + `scheduled` steuern automatische Starts; Timer übersteht Adapter-Neustarts.
- **Automatische Startauslösung**: Schaltsteckdose + optionaler Start-Trigger (z. B. SwitchBot) nach Delay.
- **Manuelle Start-Erkennung**: Bei manueller Aktivierung wird das Gerät wieder ausgeschaltet und optimal neu eingeplant (z. B. Spülmaschine).
- **SendTo-Steuerung**: Direktes Planen, Startzeit-Korrektur, Waschprogramme setzen.
- **Flexible Zeitangaben**: Deutsche Zeitformate (`dd.mm.yyyy HH:MM`, nur `HH:MM`, ISO) werden akzeptiert.
- **Laufzeit- und Ende-Erkennung**: Über Schwellenwerte + Nullverbrauchs-Phasen; verhindert Fehlabschlüsse durch Nachlauf.
- **Erinnerungen**: Trocknungs-/Ausräum-Erinnerung (Spülmaschine) nach konfigurierbarer Zeit.
- **ToDoist-Aufgaben**: Automatisches Erstellen/Abschließen von (Sub-)Tasks bei Waschmaschine.
- **Telegram-Benachrichtigungen**: Strukturierte, mehrzeilige Planungs- und Statusmeldungen.

## Architekturüberblick

Komponenten:
- `main.js`: Gerätelade- und Nachrichten-Dispatcher, Timer-Registry, Tibber- & ToDoist-Schnittstelle.
- `BaseDevice`: Gemeinsame States + generische Scheduling-Logik (Timer, Wiederherstellung, manuelle Overrides).
- Gerätespezifische Klassen:
  - `DishwasherDevice`: Minutengenaue Planung, manuelle Start-Erkennung, Dry-Reminder.
  - `WashingMachineDevice`: Erweiterte kombinierte Planung (Waschen + optional Trocknerblock), ToDoist-Tasks.
  - `DryerDevice`: Basis (kann sukzessive auf Scheduling erweitert werden).

## Installation
1. Adapter installieren (Admin oder manuell in `node_modules`).
2. Instanz anlegen.
3. Geräte konfigurieren.
4. Tibber / Telegram / ToDoist optional aktivieren.

## Konfiguration

### Grundeinstellungen
- **Tibber aktivieren / Home ID**: Erforderlich für Preisoptimierung.
- **Telegram**: Instanz + Bot konfigurieren.
- **ToDoist**: Projekt / Optional Section / Priorität.

### Geräte (pro Eintrag)
| Feld | Beschreibung |
|------|--------------|
| Geräte-ID | Interne eindeutige Kennung |
| Name | Anzeigename (auch für `sendTo` nutzbar) |
| Typ | `dishwasher`, `washingmachine`, `dryer` |
| Power State ID | Pfad zur Leistung (W) |
| Switch State ID | Pfad zum Schaltobjekt (Steckdose) |
| startTriggerStateId | (Optional) zusätzlicher Start-Trigger (z. B. SwitchBot) |
| startTriggerDelayMs | Verzögerung bis Trigger ausgelöst wird (Default 5000) |
| powerThreshold | EPS: Mindestleistung als „läuft“ (Default 0.5W) |
| detectTimeSeconds | Zeit zur Startbestätigung (Default 10s) |
| requiredMinutes / requiredHours | Geplante Laufdauer (Minuten; Stunden-Fallback) |
| minRuntimeMinutes | Mindestlaufzeit vor Endprüfung |
| zeroGraceMinutes | Haltezeit mit 0-Verbrauch vor Endprüfung |
| postConfirmMinutes | Nachbestätigung (zusätzliche Prüfung) |
| cooldownMinutes | Sperrzeit nach Abschluss |
| dryReminderMinutes | Erinnerung nach Ende (Spülmaschine) |

### Waschprogramme
- `washingPrograms`: Array z. B. `{ "program": "60", "duration": 181, "withDryer": true }`
- `dryerDuration`: Standarddauer falls Programm mit Trockner kombiniert wird.

## Gerätespezifika

| Gerät | Besonderheiten |
|-------|---------------|
| Spülmaschine | Manuelle Startdetektion, minutengenaue Neuplanung, Dry-Reminder, avgPrice-Tracking |
| Waschmaschine | Kombinierte / Split-Optimierung (Waschen + Trockner), ToDoist-Haupt- + Subtasks, Start-Trigger |
| Trockner | Einfaches Grundgerüst – kann Scheduling künftig ebenfalls nutzen |

## Preisoptimierung (Algorithmus)
1. Tibber liefert Zeitblöcke (stündlich / zukünftig auch 15-minütig). 
2. Adapter bildet Intervalle (Start–Ende) aus konsekutiven Einträgen.
3. Für jede mögliche Startminute (Intervallstarts + aktueller Zeitpunkt) wird geprüft, ob das komplette Fenster abgedeckt ist.
4. Kosten = Summe(Preis * Minutenanteil) → Durchschnittspreis.
5. Bestes (niedrigstes) Fenster wird gewählt.
6. Bei Waschmaschine mit Trockner: Vergleich der Varianten (kombiniert vs. gesplittet).

## States

Basis (alle):
- `devices.<id>.running` (bool, read-only) – Gerät läuft.
- `devices.<id>.scheduled` (bool) – Automatischer Start aktiv (wird nach Auslösung zurückgesetzt).
- `devices.<id>.startTime` (string ISO) – Geplante Startzeit ODER reale Startzeit nach tatsächlichem Leistungsanstieg.

Gerätespezifisch (Auswahl):
- Spülmaschine: `runtime`, `avgPrice`, `startDetected`.
- Waschmaschine: `runtime`, `task_id`, `subtask_gewaschen_id`.

ToDoist IDs werden persistiert, um Subtasks schließen zu können.

## sendTo-API

| Command | Payload | Wirkung |
|---------|---------|---------|
| `setWashingProgram` | `{ program: "60", withDryer: true }` | Plant Waschmaschinenprogramm (setzt `startTime` + `scheduled`). |
| `setStart` | `{ device: "Spülmaschine", start: "21.09.2025 15:10", schedule: true }` | Setzt Startzeit + optional Scheduling. |

### `setStart` Formatvarianten
Unterstützt:
- `dd.mm.yyyy HH:MM` → exaktes Datum
- `HH:MM` → Heute, falls Zeit schon vorbei → automatisch morgen
- ISO (`2025-09-21T13:05:00`) → direkt übernommen

Beispiele:
```javascript
sendTo("smart-appliances.0", "setStart", { device: "Spülmaschine", start: "22.09.2025 06:30" });
sendTo("smart-appliances.0", "setStart", { device: "Spülmaschine", start: "06:30" }); // heute oder morgen
sendTo("smart-appliances.0", "setStart", { device: "Waschmaschine", start: "15:05", schedule: false }); // nur merken, nicht planen
```
Rückgabe (Callback): `{ success: true, device, startTime, scheduled }` oder Fehlerobjekt.

## Manuelle Eingriffe / Overrides
- `startTime` manuell (ack=false) setzen → Adapter validiert & (ack=true) speichert.
- `scheduled` manuell (ack=false) auf `true` → Timer gesetzt (sofern `startTime` valide).
- Änderung von `startTime` während `scheduled=true` → Timer wird neu berechnet.
- Vergangenheit + `scheduled=true` → Sofortiger Startversuch.

## Benachrichtigungen
Telegram-Nachrichten (Beispiele):
```
Plan für Waschprogramm '60' [181 Min. + 180 Min.]:
- Waschen 21.9.2025, 11:00 → 14:01
- Trockner 21.9.2025, 14:01 → 17:01
```
```
Plan für "Spülmaschine" [120 min]:
- 21.9.2025, 11:00 → 13:00
```
Weitere Nachrichten: Start, Finished, Cancelled, Dry Reminder.

## ToDoist-Integration
Nur Waschmaschine (derzeit):
- Haupttask: `Wäsche - <Datum Zeit>`
- Subtasks: Gewaschen, Getrocknet, Entfusselt, Zusammengelegt, Aufgeräumt
- Subtask „Gewaschen“ wird beim Finish geschlossen.

## Beispiele

### Einfaches Waschprogramm per Skript
```javascript
sendTo("smart-appliances.0", "setWashingProgram", { program: "60", withDryer: true });
```

### Startzeit manuell anpassen (heute 16:02 oder morgen falls vorbei)
```javascript
sendTo("smart-appliances.0", "setStart", { device: "Spülmaschine", start: "16:02" });
```

### Nur Startzeit vormerken, nicht planen
```javascript
sendTo("smart-appliances.0", "setStart", { device: "Waschmaschine", start: "23.09.2025 05:45", schedule: false });
```

### Direkter ISO Start
```javascript
sendTo("smart-appliances.0", "setStart", { device: "Spülmaschine", start: "2025-09-22T04:15:00" });
```

## Troubleshooting
| Problem | Ursache | Lösung |
|---------|---------|--------|
| `scheduled` springt sofort auf false | Startzeit in Vergangenheit | Neue Startzeit setzen oder sofort ausführen lassen |
| Kein automatischer Start | `scheduled=false` oder `switchStateId` fehlt | Prüfen ob scheduling aktiviert / Steckdose konfiguriert |
| Nachricht „kein gültiges Fenster“ | Tibber-Daten unvollständig | Prüfen Tibber Adapter + zukünftige Preise |
| Manuelle Änderung greift nicht | ack=true direkt gesetzt | Mit ack=false setzen oder `setStart` nutzen |
| Start zu früh gestartet | Zeit bereits überschritten | Gezielte Zeit in Zukunft setzen |

## Changelog

### Unreleased
- Minutengenaue Preisoptimierung (Dishwasher & WashingMachine)
- Generische Scheduling-Logik in BaseDevice
- `setStart` sendTo-Befehl (Formate: HH:MM / dd.mm.yyyy HH:MM / ISO)
- Mehrzeilige Telegram-Benachrichtigungen
- Waschmaschinen ToDoist-Subtasks
- Start-Trigger (switch + optionaler externer Trigger)

### 0.1.0 (2024-12-16)
- Erste Version (Grundfunktion Spülmaschine, Tibber-Integration, Telegram)

## License
MIT License
