/*
 * Every DOM selector the extension depends on, in one place.
 *
 * `confirmed: true`  -> verified byte-for-byte against a real captured page
 *                       (captures/working-screen/working-screen.html, or
 *                       captures/data-feed/data-feed.html for the dataFeed block).
 * `confirmed: false` -> inferred. Check against the live DOM before relying on it.
 */
(function (root) {
  'use strict';

  var SELECTORS = {
    // Anchor for the lead-detail block. Unique id, verified at :386.
    // We reach the transcript blob through this rather than through class soup,
    // because the classes on the blob itself are generic Bootstrap utilities.
    leadIdAnchor: {
      sel: '#working_lead_id',
      confirmed: true,
      note: 'working-screen.html:386 - <span id="working_lead_id">27253318</span>'
    },

    // The unstructured feed/category/keywords/transcript blob.
    // Primary path: leadIdAnchor -> closest(.form-group) -> this.
    leadBlobWithinGroup: {
      sel: 'span.form-control-static',
      confirmed: true,
      note: 'working-screen.html:389 - class="form-control-static d-block text-muted ps-2"'
    },

    // Fallback path if the markup around #working_lead_id ever changes.
    // Candidates are filtered by content (APA.lead.looksLikeLeadBlob), not by class.
    leadBlobFallback: {
      sel: '.applet-body span.form-control-static',
      confirmed: true,
      note: 'content-filtered fallback; .ps-2 alone is too fragile to trust'
    },

    // The raw audio link. Matches openFullScreen onclick handler, signal.alertpage.net media links,
    // or standard audio file links.
    audioLink: {
      sel: 'a[onclick^="openFullScreen"], a[href*="signal.alertpage.net"], a[href*="media-alrtpg"], a[href*="/media/"], a[href$=".m4a"], a[href$=".mp3"]',
      confirmed: true,
      note: 'working-screen.html:407, bug.md signal.alertpage.net link'
    },

    // --- Not used in Phase 1. Listed so Phase 2/3 inherit the same discipline. ---

    chatContainer: {
      sel: '#chat-box-container-1',
      confirmed: true,
      note: 'working-screen.html:1697 - MutationObserver target for monitoring detection'
    },
    // Set by the page via jQuery .val(), which fires no events - and #cityname is
    // `disabled`, so it would not fire input/change even if it did. Hence the poll.
    cityName:     { sel: '#cityname',     confirmed: true, note: ':1022 - disabled, name="city"' },
    jurisdiction: { sel: '#jurisdiction', confirmed: true, note: ':1052 - editable, defaults to " "' },

    internalNotes: {
      sel: '#internal-notes',
      confirmed: true,
      note: 'working-screen.html:1402 - name="internal_notes"; paired change handler at :2303 clears the required-field error'
    },

    countyName: { sel: '#countyname', confirmed: true, note: ':1030 - value="New York"' },
    countyId:   { sel: '#countyid',   confirmed: true, note: ':1031 - value="21"' },
    stateName:  { sel: '#statename',  confirmed: true, note: ':1040 - full name, not abbreviation' },

    // The page's own "Lead Details" heading - separate from #working_lead_id's label
    // (.apa-head, built by enhanceHeader()). #lead-form's id is stable; the heading
    // itself carries no id/class of its own.
    leadDetailsHeading: {
      sel: '#lead-form .applet-head.is h2',
      confirmed: true,
      note: 'working-screen.html:379 - <h2>Lead Details</h2> inside .applet-head.is'
    },
    // Only room 1 initializes for this dispatcher role - see FINDINGS.md "Chat WebSocket".
    chatInput: {
      sel: '#chat-text-box-1',
      confirmed: true,
      note: 'working-screen.html:1700 - placeholder="Write your message.."'
    },
    // Clicked by the Monitor button only when monitorAutoSendEnabled is on.
    chatSendButton: {
      sel: '#msg-submit-1',
      confirmed: true,
      note: 'working-screen.html:1701 - type="submit"; click handler at :2024 sends over the chat WebSocket'
    },

    // Footer action buttons/checkboxes, reached individually rather than via
    // .applet-footer (not uniquely id'd) - each anchor is walked up to its
    // closest() container by the caller.
    doNotSendButton:       { sel: '#do-not-send-button',              confirmed: true, note: 'working-screen.html:1415' },
    markAsDuplicateButton: { sel: '#mark-as-duplicate-button',        confirmed: true, note: 'working-screen.html:1423' },
    sendSupervisorButton:  { sel: '#send-supervisor-button',          confirmed: true, note: 'working-screen.html:1419' },
    logoutCheckbox:        { sel: 'input[name="logout"]',             confirmed: true, note: 'working-screen.html:1411' },
    sendTechnicalCheckbox: { sel: 'input[name="send_technical"]',     confirmed: true, note: 'working-screen.html:1427' },
    // Labelled "Primary Alert"; this is the mark-as-duplicate picker, NOT a lead queue.
    // Whether bootstrap-multiselect upgrades it is UNVERIFIED - the init call lives in
    // app.js / volunteer_dispatcher_script.js, neither of which was captured.
    primaryAlertSelect: { sel: '#prim-lead-select', confirmed: false, note: ':428' },
    sentAlerts:         { sel: '.applet-sidebar .form-group', confirmed: true, note: ':1447+' },

    // --- Phase 3: the Data Feed page on ap-portal.alertpage.net, a different host. ---
    //
    // All confirmed against live markup captured 2026-09-02
    // (captures/data-feed/data-feed.html). Every one of these selects carries an
    // inline onchange= attribute, which is what makes them drivable from a content
    // script: the page's JS itself is unreachable from our isolated world, but a
    // dispatched change event still runs the inline handler.
    dataFeed: {
      systemSelect:    { sel: '#system_selection',     confirmed: true, note: 'onchange="fetchTalkgroups()"; pre-selectable via ?ltp_id= on the URL' },
      talkgroupSelect: { sel: '#talkgroup_selection',  confirmed: true, note: 'onchange="fetchTransmissionsFirstPage()"; option value is talkgroup_decimal, text is talkgroup_name' },
      countySelect:    { sel: '#county_selection',     confirmed: true, note: 'onchange="fetchTransmissionsFirstPage()"; options are bare talkgroup_county values ("Bexar"), same shape as #countyname' },
      groupSelect:     { sel: '#group_selection',      confirmed: true, note: 'onchange="fetchTransmissionsFirstPage()"; not synced' },
      // name="service_selection" but id="service_type_selection" - they differ.
      serviceSelect:   { sel: '#service_type_selection', confirmed: true, note: 'name and id differ; not synced' },
      timeSelect:      { sel: '#time_selection',       confirmed: true, note: 'onchange="onTimeChanged()"; values 1..48 hours plus "custom"' },
      startDate:       { sel: '#start_date',           confirmed: true, note: 'input[type=datetime-local], read back as browser-local' },
      endDate:         { sel: '#end_date',             confirmed: true, note: 'input[type=datetime-local], read back as browser-local' },
      customRange:     { sel: '#customRangeContainer', confirmed: true, note: 'starts .d-none; onTimeChanged() reveals it' },
      applyRange:      { sel: '#customRangeContainer button.btn-primary', confirmed: true, note: 'onclick="applyCustomRange()" - the only reachable route to a custom range' },
      filterPanel:     { sel: '#filterAccordion',      confirmed: true, note: 'banner is inserted before this' },
      // If either is showing, the session is gone and there is nothing to filter.
      loginModal:      { sel: '#loginModal',           confirmed: true, note: 'auth gate' },
      mustLoginModal:  { sel: '#mustloginModal',       confirmed: true, note: 'auth gate' },

      // Summarize feature: jump-to-source scrolls/highlights a row here once the page
      // re-fetches around a cited transmission's timestamp.
      transmissionList:      { sel: '#transmission-list', confirmed: true, note: 'data-feed.html:383; rebuilt wholesale (innerHTML="") on every ~30s fetch' },
      transmissionTimestamp: { sel: '.transmission-timestamp[data-timestamp]', confirmed: true, note: 'data-feed.html:1002-1007; data-timestamp is epoch MS (transmission_time_stamp * 1000)' }
    }
  };

  root.APA = root.APA || {};
  root.APA.selectors = SELECTORS;

  if (typeof module !== 'undefined' && module.exports) { module.exports = SELECTORS; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
