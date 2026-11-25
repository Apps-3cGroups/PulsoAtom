// Dated audit snapshot. The default applies only to an empty summary URL;
// explicit filters and return links always keep the user's chosen view.
// Period shape: { id, label, from, to, countries: ['HN', ...], count? }.
export const meetingPeriodSnapshot = {
  asOf: '2026-11-25T14:57:52.000Z',
  defaultPeriodId: 'meeting-six-20261125',
  periods: [
    { id: 'meeting-volume-20261125', label: '4–6 nov · mayor volumen', from: '2026-11-04', to: '2026-11-06', countries: ['HN', 'PA', 'SV', 'MX'] },
    { id: 'meeting-six-20261125', label: '17–19 nov · seis países', from: '2026-11-17', to: '2026-11-19', countries: ['HN', 'PA', 'CR', 'SV', 'MX', 'NI'] },
  ],
};
