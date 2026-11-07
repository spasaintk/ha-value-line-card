# Value Line Card

A Home Assistant Lovelace card that draws a sensor's history as a line whose **colour follows the value** against thresholds you define — green when low, red when high — with a Y axis that **auto-scales to the data**.

Unlike a fixed-gradient trick, the colour gradient is recomputed against the live data range on every refresh, so the line stays value-coloured **and is never clipped** by a fixed ceiling.

## Installation

Add this repository to the Home Assistant Marketplace / HACS as a custom repository (category **Dashboard**) and install, then add it on a dashboard as a resource of type *JavaScript Module*.

Or manually: copy `dist/value-line-card.js` into `config/www/` and add `/local/value-line-card.js` as a dashboard resource (*JavaScript Module*).

## Usage

```yaml
type: custom:value-line-card
entity: sensor.co2
title: CO₂
unit: ppm
hours: 24
thresholds:
  - { value: 400, color: '#8FD08A' }
  - { value: 800, color: '#F2D06B' }
  - { value: 1400, color: '#FF8A70' }
  - { value: 2000, color: '#E0607A' }
```

Long range using long-term statistics (hourly / daily mean):

```yaml
type: custom:value-line-card
entity: sensor.co2
days: 30
statistics: mean
period: day
thresholds:
  - { value: 400, color: '#8FD08A' }
  - { value: 1000, color: '#FFB86B' }
  - { value: 2000, color: '#E0607A' }
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `entity` | string | **required** | The sensor to chart. |
| `thresholds` | list | **required** | `{value, color}` stops, green → red by value. At least two. |
| `title` | string | friendly name | Header title. |
| `unit` | string | entity unit | Header unit. |
| `hours` | number | `24` | Time window in hours. |
| `days` | number | — | Time window in days (overrides `hours`). |
| `span` | string | — | Window like `24h`, `7d`, `2w` (overrides `hours`). |
| `statistics` | string | — | Use long-term statistics (`mean` / `min` / `max`) instead of raw history. |
| `period` | string | `hour` | Statistics bucket (`hour` / `day`) when `statistics` is set. |
| `height` | number | `230` | Chart height in px. |
| `y_min` / `y_max` | number | auto | Pin an axis bound (otherwise auto-scaled). |

## How the colouring works

The thresholds are mapped onto the **live** Y axis on every refresh. ApexCharts gradient offsets are a percentage of chart height, so pinning the gradient to the current axis range makes the colour track the real value as the axis moves. A reading above the top threshold shows the top colour; below the bottom threshold shows the bottom colour.

## License

MIT
