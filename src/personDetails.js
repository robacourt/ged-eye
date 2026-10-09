import { PhotoViewer } from './photoViewer.js';
import { thumbUrl } from './media.js';
import { escapeHtml } from './html.js';
import { factLabel } from './factLabels.js';

// Person notes longer than this are clamped to about NOTE_CLAMP_LINES lines behind "Show more".
const NOTE_CLAMP_LINES = 6;
const NOTE_CLAMP_CHARS = 500;

/** A fact's notes behind a native disclosure; summaryWord is "Note" or "Transcription". */
function notesDisclosure(notes, summaryWord = 'Note') {
  if (!notes?.length) return '';
  const summary = notes.length === 1 ? summaryWord : `${summaryWord}s (${notes.length})`;
  const bodies = notes.map(note => `<div class="note-text">${escapeHtml(note)}</div>`).join('');
  return `<details class="detail-notes"><summary>${escapeHtml(summary)}</summary>${bodies}</details>`;
}

/**
 * The one structure every row shares: an optional label, then the value. The label is escaped here;
 * valueHtml is already-escaped markup. With no value the label stands alone, without its colon.
 */
function labelledRow(label, valueHtml) {
  const labelHtml = label ? `<span class="detail-label">${escapeHtml(label)}${valueHtml ? ':' : ''}</span>` : '';
  const valueDiv = valueHtml ? `<div class="detail-value">${valueHtml}</div>` : '';
  return `<div class="detail-item">${labelHtml}${valueDiv}</div>`;
}

/**
 * One fact: "label: value • date • place", an optional cause, and its notes. Every field is optional.
 * The fact is data (it may be a stored object spread in); label and summaryWord are the caller's own.
 */
function factRow({ value, date, place, cause, notes }, { label, summaryWord } = {}) {
  const parts = [];
  if (value) parts.push(`<span class="detail-fact">${escapeHtml(value)}</span>`);
  if (date) parts.push(`<span class="detail-date">${escapeHtml(date)}</span>`);
  if (place) parts.push(`<span class="detail-place">${escapeHtml(place)}</span>`);
  let valueHtml = parts.join(' • ');
  if (cause) valueHtml += `<div class="detail-cause">Cause: ${escapeHtml(cause)}</div>`;
  valueHtml += notesDisclosure(notes, summaryWord);
  return labelledRow(label, valueHtml);
}

function personNote(note) {
  const long = note.length > NOTE_CLAMP_CHARS || note.split('\n').length > NOTE_CLAMP_LINES;
  if (!long) return `<div class="person-note"><div class="note-text">${escapeHtml(note)}</div></div>`;
  return `<div class="person-note"><div class="note-text note-clamped">${escapeHtml(note)}</div>` +
    '<button type="button" class="note-toggle" aria-expanded="false">Show more</button></div>';
}

// title is always a literal from the caller, never data, so it is not escaped.
function section(title, rows) {
  return rows.length ? `<div class="person-details-section"><h3>${title}</h3>${rows.join('')}</div>` : '';
}

const SEX_LABELS = new Map([['M', 'Male'], ['F', 'Female']]);

// Occupations were plain strings before the 2026-10 facts backfill.
const asFact = (entry) => (typeof entry === 'string' ? { value: entry } : entry);

/**
 * Person details panel component
 */
export class PersonDetails {
  constructor(containerElement) {
    this.container = containerElement;
    this.currentPerson = null;
    this.photoViewer = new PhotoViewer();
    this.createPanel();
  }

  createPanel() {
    this.container.innerHTML = `
      <div class="person-details">
        <div class="person-details-content">
          <div class="person-details-empty">
            Select a person to view their details
          </div>
        </div>
      </div>
    `;

    this.panel = this.container.querySelector('.person-details');
    this.content = this.container.querySelector('.person-details-content');
    this.emptyState = this.container.querySelector('.person-details-empty');
  }

  /**
   * Display details for a person
   */
  async showPerson(personData, relationships = null) {
    this.currentPerson = personData;
    this.relationships = relationships;
    this.emptyState.style.display = 'none';

    // Reset scroll position to top
    this.content.scrollTop = 0;

    const sexLabel = SEX_LABELS.get(personData.sex);
    let html = `
      <div class="person-details-header">
        <h2>${escapeHtml(personData.name || 'Unknown')}</h2>
        ${sexLabel ? `<span class="person-sex">${sexLabel}</span>` : ''}
      </div>
    `;

    // Add photo thumbnails if available (max 4)
    if (personData.photos && personData.photos.length > 0) {
      const maxThumbnails = Math.min(4, personData.photos.length);
      html += '<div class="person-photos-row">';
      for (let i = 0; i < maxThumbnails; i++) {
        const photo = personData.photos[i];
        if (photo.thumbKey) {
          html += `
            <div class="person-photo-thumbnail" data-photo-index="${i}">
              <img src="${escapeHtml(thumbUrl(photo))}" alt="Photo ${i + 1}" />
            </div>
          `;
        } else {
          html += `
            <div class="person-photo-thumbnail person-photo-file" data-photo-index="${i}">
              <div class="file-icon">📄</div>
            </div>
          `;
        }
      }
      html += '</div>';
    }

    html += '<div class="person-details-sections">';

    const lifeEvents = [
      { label: 'Birth', date: personData.birthDate, place: personData.birthPlace, notes: personData.birthNotes },
      { label: 'Baptism', date: personData.baptismDate, place: personData.baptismPlace, notes: personData.baptismNotes },
      { label: 'Death', date: personData.deathDate, place: personData.deathPlace, notes: personData.deathNotes, cause: personData.causeOfDeath },
      { label: 'Burial', date: personData.burialDate, place: personData.burialPlace, notes: personData.burialNotes }
    ].filter(event => event.date || event.place || event.notes?.length || event.cause);
    html += section('Life Events', lifeEvents.map(event => factRow(event, { label: event.label })));

    if (personData.marriages?.length && this.relationships?.spouses) {
      const rows = [];
      for (const marriage of personData.marriages) {
        const spouse = this.relationships.spouses.find(s => s.id === marriage.spouseId);
        rows.push(labelledRow('Spouse', `<strong>${escapeHtml(spouse?.name || 'Unknown')}</strong>`));
        if (marriage.marriageDate || marriage.marriagePlace) {
          rows.push(factRow({ date: marriage.marriageDate, place: marriage.marriagePlace }, { label: 'Married' }));
        }
        if (marriage.divorceDate || marriage.divorcePlace) {
          rows.push(factRow({ date: marriage.divorceDate, place: marriage.divorcePlace }, { label: 'Divorced' }));
        }
      }
      html += section('Marriages', rows);
    }

    html += section('Occupations', (personData.occupations ?? []).map(entry => factRow(asFact(entry))));

    const otherRows = (personData.otherFacts ?? []).map(fact => factRow(fact, { label: factLabel(fact) }));
    if (personData.religion) otherRows.push(factRow({ value: personData.religion }, { label: 'Religion' }));
    if (personData.education) otherRows.push(factRow({ value: personData.education }, { label: 'Education' }));
    html += section('Other details', otherRows);

    html += section('Census Records', (personData.censusRecords ?? []).map(census => factRow(census, { summaryWord: 'Transcription' })));
    html += section('Residences', (personData.residences ?? []).map(residence => factRow(residence)));
    html += section('Notes', (personData.notes ?? []).map(personNote));

    const contact = [];
    if (personData.email) {
      contact.push(labelledRow('Email', `<a href="mailto:${escapeHtml(personData.email)}">${escapeHtml(personData.email)}</a>`));
    }
    if (personData.phone) {
      contact.push(labelledRow('Phone', `<a href="tel:${escapeHtml(personData.phone)}">${escapeHtml(personData.phone)}</a>`));
    }
    html += section('Contact', contact);

    html += '</div>'; // Close sections

    this.content.innerHTML = html;

    // Add click handlers to photo thumbnails
    const thumbnails = this.content.querySelectorAll('.person-photo-thumbnail');
    thumbnails.forEach(thumbnail => {
      thumbnail.addEventListener('click', () => {
        const photoIndex = parseInt(thumbnail.getAttribute('data-photo-index'));
        this.openPhotoViewer(photoIndex);
      });
    });

    // A note that is long by the rules above may still fit in the clamped box (wide panel, few wrapped
    // lines). Those need no clamp or button. A height of 0 means nothing has been laid out (jsdom, or a
    // panel that is not displayed), so the note is left as rendered.
    this.content.querySelectorAll('.note-clamped').forEach(text => {
      if (text.clientHeight && text.scrollHeight <= text.clientHeight + 1) {
        text.classList.remove('note-clamped');
        text.parentElement.querySelector('.note-toggle')?.remove();
      }
    });

    this.content.querySelectorAll('.note-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const text = button.parentElement.querySelector('.note-text');
        const expanded = !text.classList.toggle('note-clamped');
        button.textContent = expanded ? 'Show less' : 'Show more';
        button.setAttribute('aria-expanded', String(expanded));
        // Collapsing a long note can leave the page scrolled past its start.
        if (!expanded) text.scrollIntoView?.({ block: 'nearest' });
      });
    });
  }

  /**
   * Open photo viewer at a specific photo index
   */
  openPhotoViewer(startIndex = 0) {
    if (!this.currentPerson || !this.currentPerson.photos || this.currentPerson.photos.length === 0) {
      return;
    }

    // Open viewer and set to the specified index
    this.photoViewer.open(this.currentPerson.name, this.currentPerson.photos);
    this.photoViewer.currentIndex = startIndex;
    this.photoViewer.updateDisplay();
  }

  /**
   * Clear the details panel
   */
  clear() {
    this.currentPerson = null;
    this.content.innerHTML = '';
    this.emptyState.style.display = 'flex';
  }
}
