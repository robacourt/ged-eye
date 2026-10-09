import { PhotoViewer } from './photoViewer.js';
import { thumbUrl } from './media.js';
import { escapeHtml } from './html.js';
import { factLabel } from './factLabels.js';
import { familyOfChild, nameOf, relativeBlocked } from './familyLinks.js';

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

const ADD_RELATIVES = [['parent', '+ Parent'], ['spouse', '+ Spouse'], ['child', '+ Child'], ['sibling', '+ Sibling']];
let nextHintId = 0;

/**
 * The editors' controls, when `canEdit`: each control gets a `data-edit-action` index into `actions`, and
 * showPerson() wires the clicks once the HTML is in place. Every label is escaped here.
 */
class EditControls {
  constructor(person, relationships, hooks) {
    this.person = person;
    this.relationships = relationships;
    this.hooks = hooks;
    this.actions = [];
  }

  /** A button that runs `run` when clicked. `text` and `label` are escaped; `className` is a literal. */
  button(className, text, label, run, { disabled = false, describedBy = null } = {}) {
    this.actions.push(run);
    const attributes = [
      `type="button"`, `class="${className}"`, `data-edit-action="${this.actions.length - 1}"`,
      label ? `aria-label="${escapeHtml(label)}"` : '', disabled ? 'disabled' : '',
      describedBy ? `aria-describedby="${describedBy}"` : ''
    ].filter(Boolean);
    return `<button ${attributes.join(' ')}>${escapeHtml(text)}</button>`;
  }

  call(name, ...args) {
    this.hooks[name]?.(...args, this.person);
  }

  unlink(relation, personId, familyId, name) {
    const what = { parent: 'a parent', spouse: 'the spouse', child: 'a child' }[relation];
    const target = { relation, role: relation === 'child' ? 'child' : 'partner', personId, familyId };
    return this.button('details-unlink', '×', `Remove ${name} as ${what}`, () => this.call('onUnlink', target));
  }

  /** The Edit button in the header. */
  editPerson() {
    return this.button('details-edit-person', 'Edit', `Edit ${nameOf(this.person)}`, () => this.hooks.onEdit?.(this.person));
  }

  /** Edit and × for a marriage row; × only when the spouse is known. */
  marriageActions(marriage, spouse) {
    const partners = [{ id: this.person.id, name: this.person.name ?? '' }];
    if (marriage.spouseId) partners.push({ id: marriage.spouseId, name: spouse?.name ?? '' });
    const family = {
      familyId: marriage.familyId, partners,
      marriageDate: marriage.marriageDate ?? null, marriagePlace: marriage.marriagePlace ?? null,
      divorceDate: marriage.divorceDate ?? null, divorcePlace: marriage.divorcePlace ?? null
    };
    const label = `Edit the marriage of ${partners.map(nameOf).join(' and ')}`;
    const edit = this.button('details-edit-family', 'Edit', label, () => this.call('onEditFamily', family));
    const remove = marriage.spouseId ? this.unlink('spouse', marriage.spouseId, marriage.familyId, nameOf(spouse)) : '';
    return `<span class="details-row-actions">${edit}${remove}</span>`;
  }

  /** The Family section: parents and children with ×, the + relative buttons, and the History link. */
  familySection() {
    const rows = [];
    const byId = new Map((this.relationships?.parents ?? []).map(parent => [parent.id, parent]));
    for (const family of this.person.parentFamilies ?? []) {
      for (const parentId of family.partnerIds ?? []) {
        const name = nameOf(byId.get(parentId));
        rows.push(labelledRow('Parent', `<strong>${escapeHtml(name)}</strong>` +
          `<span class="details-row-actions">${this.unlink('parent', parentId, family.familyId, name)}</span>`));
      }
    }
    for (const child of this.relationships?.children ?? []) {
      const familyId = familyOfChild(this.person, child);
      const remove = familyId ? `<span class="details-row-actions">${this.unlink('child', child.id, familyId, nameOf(child))}</span>` : '';
      rows.push(labelledRow('Child', `<strong>${escapeHtml(nameOf(child))}</strong>${remove}`));
    }

    const hints = [];
    const buttons = ADD_RELATIVES.map(([relation, text]) => {
      const blocked = relativeBlocked(this.person, relation);
      let describedBy = null;
      if (blocked) {
        describedBy = `details-add-hint-${++nextHintId}`;
        hints.push(`<p class="details-add-hint" id="${describedBy}">${escapeHtml(blocked)}</p>`);
      }
      return this.button('details-add', text, null, () => this.call('onAddRelative', relation), { disabled: Boolean(blocked), describedBy });
    });

    return '<div class="person-details-section details-family"><h3>Family</h3>' + rows.join('') +
      `<div class="details-add-relatives">${buttons.join('')}</div>${hints.join('')}` +
      `<div class="details-history-row">${this.button('details-history', 'History of this person', null, () => this.hooks.onShowHistory?.(this.person))}</div>` +
      '</div>';
  }

  /** Wires every control rendered into `root`. */
  wire(root) {
    root.querySelectorAll('[data-edit-action]').forEach(control => {
      const run = this.actions[Number(control.dataset.editAction)];
      control.addEventListener('click', () => run?.());
    });
  }
}

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
   * Display details for a person.
   * @param options  for editors: `{ canEdit, onEdit(person), onAddRelative(relation, person),
   *   onUnlink({ relation, role, personId, familyId }, person), onEditFamily(family, person), onShowHistory(person) }`.
   *   Without `canEdit` no edit control is rendered. `relation` is 'parent' | 'spouse' | 'child' | 'sibling';
   *   `family` is openFamilyEditor's `{ familyId, partners: [{ id, name }], marriageDate, marriagePlace,
   *   divorceDate, divorcePlace }`.
   */
  async showPerson(personData, relationships = null, options = {}) {
    this.currentPerson = personData;
    this.relationships = relationships;
    this.emptyState.style.display = 'none';
    const edit = options?.canEdit ? new EditControls(personData, relationships, options) : null;

    // Reset scroll position to top
    this.content.scrollTop = 0;

    const sexLabel = SEX_LABELS.get(personData.sex);
    let html = `
      <div class="person-details-header">
        <h2>${escapeHtml(personData.name || 'Unknown')}</h2>
        ${sexLabel ? `<span class="person-sex">${sexLabel}</span>` : ''}
        ${edit ? edit.editPerson() : ''}
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
        const actions = edit ? edit.marriageActions(marriage, spouse) : '';
        rows.push(labelledRow('Spouse', `<strong>${escapeHtml(spouse?.name || 'Unknown')}</strong>${actions}`));
        if (marriage.marriageDate || marriage.marriagePlace) {
          rows.push(factRow({ date: marriage.marriageDate, place: marriage.marriagePlace }, { label: 'Married' }));
        }
        if (marriage.divorceDate || marriage.divorcePlace) {
          rows.push(factRow({ date: marriage.divorceDate, place: marriage.divorcePlace }, { label: 'Divorced' }));
        }
      }
      html += section('Marriages', rows);
    }

    if (edit) html += edit.familySection();

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
    edit?.wire(this.content);

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
