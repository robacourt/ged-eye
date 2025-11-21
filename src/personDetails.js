/**
 * Person details panel component
 */
export class PersonDetails {
  constructor(containerElement) {
    this.container = containerElement;
    this.currentPerson = null;
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
  showPerson(personData) {
    this.currentPerson = personData;
    this.emptyState.style.display = 'none';

    // Build the details HTML
    let html = `
      <div class="person-details-header">
        <h2>${personData.name || 'Unknown'}</h2>
        ${personData.sex ? `<span class="person-sex">${personData.sex === 'M' ? 'Male' : 'Female'}</span>` : ''}
      </div>

      <div class="person-details-sections">
    `;

    // Life events section
    const lifeEvents = [];
    if (personData.birthDate || personData.birthPlace) {
      lifeEvents.push({
        label: 'Birth',
        date: personData.birthDate,
        place: personData.birthPlace
      });
    }
    if (personData.baptismDate || personData.baptismPlace) {
      lifeEvents.push({
        label: 'Baptism',
        date: personData.baptismDate,
        place: personData.baptismPlace
      });
    }
    if (personData.deathDate || personData.deathPlace) {
      lifeEvents.push({
        label: 'Death',
        date: personData.deathDate,
        place: personData.deathPlace
      });
    }
    if (personData.burialDate || personData.burialPlace) {
      lifeEvents.push({
        label: 'Burial',
        date: personData.burialDate,
        place: personData.burialPlace
      });
    }

    if (lifeEvents.length > 0) {
      html += '<div class="person-details-section">';
      html += '<h3>Life Events</h3>';
      lifeEvents.forEach(event => {
        html += `<div class="detail-item">`;
        html += `<span class="detail-label">${event.label}:</span>`;
        html += `<span class="detail-value">`;
        if (event.date) html += `<span class="detail-date">${event.date}</span>`;
        if (event.date && event.place) html += ' • ';
        if (event.place) html += `<span class="detail-place">${event.place}</span>`;
        html += `</span>`;
        html += `</div>`;
      });
      html += '</div>';
    }

    // Occupations
    if (personData.occupations && personData.occupations.length > 0) {
      html += '<div class="person-details-section">';
      html += '<h3>Occupations</h3>';
      personData.occupations.forEach(occ => {
        html += `<div class="detail-item"><span class="detail-value">${occ}</span></div>`;
      });
      html += '</div>';
    }

    // Census records
    if (personData.censusRecords && personData.censusRecords.length > 0) {
      html += '<div class="person-details-section">';
      html += '<h3>Census Records</h3>';
      personData.censusRecords.forEach(census => {
        html += `<div class="detail-item">`;
        html += `<span class="detail-value">`;
        if (census.date) html += `<span class="detail-date">${census.date}</span>`;
        if (census.date && census.place) html += ' • ';
        if (census.place) html += `<span class="detail-place">${census.place}</span>`;
        html += `</span>`;
        html += `</div>`;
      });
      html += '</div>';
    }

    // Residences
    if (personData.residences && personData.residences.length > 0) {
      html += '<div class="person-details-section">';
      html += '<h3>Residences</h3>';
      personData.residences.forEach(residence => {
        html += `<div class="detail-item">`;
        html += `<span class="detail-value">`;
        if (residence.date) html += `<span class="detail-date">${residence.date}</span>`;
        if (residence.date && residence.place) html += ' • ';
        if (residence.place) html += `<span class="detail-place">${residence.place}</span>`;
        html += `</span>`;
        html += `</div>`;
      });
      html += '</div>';
    }

    // Notes
    if (personData.notes && personData.notes.length > 0) {
      html += '<div class="person-details-section">';
      html += '<h3>Notes</h3>';
      personData.notes.forEach(note => {
        html += `<div class="detail-item"><span class="detail-value">${note}</span></div>`;
      });
      html += '</div>';
    }

    // Contact info (for living people)
    if (personData.email || personData.phone) {
      html += '<div class="person-details-section">';
      html += '<h3>Contact</h3>';
      if (personData.email) {
        html += `<div class="detail-item">`;
        html += `<span class="detail-label">Email:</span>`;
        html += `<span class="detail-value"><a href="mailto:${personData.email}">${personData.email}</a></span>`;
        html += `</div>`;
      }
      if (personData.phone) {
        html += `<div class="detail-item">`;
        html += `<span class="detail-label">Phone:</span>`;
        html += `<span class="detail-value"><a href="tel:${personData.phone}">${personData.phone}</a></span>`;
        html += `</div>`;
      }
      html += '</div>';
    }

    html += '</div>'; // Close sections

    this.content.innerHTML = html;
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
