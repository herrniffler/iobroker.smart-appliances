# Smart Appliances Adapter für ioBroker

Intelligenter Großgeräte-Scheduler mit Tibber-Energiepreis-Optimierung

## Funktionen

- **Automatische Geräteerkennung**: Erkennt den manuellen Start von Großgeräten über Stromverbrauchsmessung
- **Tibber-Integration**: Findet die günstigsten aufeinanderfolgenden Stunden für den optimalen Gerätestart
- **Intelligente Zustandserkennung**: Überwacht Gerätelaufzeit und erkennt automatisch das Ende von Programmen
- **Flexible Konfiguration**: Unterstützt verschiedene Gerätetypen (Spülmaschine, Waschmaschine, Trockner)
- **Benachrichtigungen**: Integration mit Telegram für Status-Updates
- **Erinnerungen**: Automatische Erinnerung zum Ausräumen (z.B. bei Spülmaschinen)

## Installation

1. Adapter aus dem ioBroker Admin installieren oder manuell in den `node_modules` Ordner kopieren
2. Instanz erstellen und konfigurieren
3. Geräte in der Adapter-Konfiguration hinzufügen

## Konfiguration

### Grundeinstellungen
- **Tibber aktivieren**: Ermöglicht die automatische Energiepreis-Optimierung
- **Tibber Home ID**: Ihre Tibber Home ID für den Zugriff auf Preisdaten

### Benachrichtigungen
- **Telegram**: Optional - Telegram-Bot für Status-Nachrichten

### Geräte
Für jedes Gerät können folgende Parameter konfiguriert werden:

- **Geräte-ID**: Eindeutige Kennung
- **Name**: Anzeigename
- **Typ**: Spülmaschine, Waschmaschine oder Trockner
- **Power State ID**: State-ID für Stromverbrauchsmessung (Watt)
- **Switch State ID**: State-ID zum Ein-/Ausschalten
- **Schwellenwert**: Mindestverbrauch für "Gerät läuft" (Standard: 0.5W)
- **Erkennungszeit**: Bestätigungszeit für Gerätestart (Standard: 10s)
- **Laufzeit**: Benötigte günstige Stunden (Standard: 2h)
- **Min. Laufzeit**: Mindestlaufzeit vor Ende-Erkennung (Standard: 110min)
- **Zero-Power Zeit**: Zeit bei null Verbrauch vor Ende (Standard: 10min)
- **Bestätigungszeit**: Zusätzliche Bestätigung nach Ende (Standard: 2min)
- **Cooldown**: Pause nach Geräteende (Standard: 10min)
- **Trocknungserinnerung**: Erinnerung nach Programmende (Standard: 45min)

## Funktionsweise

### Automatische Erkennung
1. Adapter überwacht den Stromverbrauch aller konfigurierten Geräte
2. Bei manuellem Start wird das Gerät sofort abgeschaltet
3. Adapter sucht die günstigsten aufeinanderfolgenden Stunden basierend auf Tibber-Preisen
4. Gerät wird automatisch zur optimalen Zeit gestartet

### Zustandsüberwachung
- **Start**: Erkennung über Stromverbrauchsanstieg
- **Laufzeit**: Kontinuierliche Überwachung
- **Ende**: Erkennung über längeren Nullverbrauch
- **Erinnerungen**: Automatische Nachrichten nach Programmende

## States

Für jedes Gerät werden folgende States erstellt:

- `devices.{geräte-id}.running` - Gerät läuft
- `devices.{geräte-id}.scheduled` - Geplanter Start aktiv
- `devices.{geräte-id}.startTime` - Geplante Startzeit
- `devices.{geräte-id}.runtime` - Laufzeit in Millisekunden
- `devices.{geräte-id}.avgPrice` - Durchschnittspreis für geplanten Lauf

## Voraussetzungen

- ioBroker Installation
- Tibber-Adapter (für Preisoptimierung)
- Telegram-Adapter (optional, für Benachrichtigungen)
- Geräte mit Stromverbrauchsmessung und schaltbarer Steckdose

## Changelog

### 0.1.0 (2024-12-16)
- Erste Version
- Spülmaschinen-Unterstützung mit Tibber-Integration
- Automatische Start-/Ende-Erkennung
- Telegram-Benachrichtigungen

## License
MIT License
