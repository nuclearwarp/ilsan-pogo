// ==UserScript==
// @id           s2check@alfonsoml
// @name         Pogo Tools (NuclearWarp ver)
// @category     Layer
// @namespace    https://gitlab.com/AlfonsoML/pogo-s2/
// @supportURL   https://twitter.com/PogoCells
// @version      0.93.31
// @description  Pokemon Go tools over IITC. News on https://twitter.com/PogoCells
// @author       Alfonso M.
// @modify       CP0xNuclearWarp
// @match        https://intel.ingress.com/*
// @grant        none
// ==/UserScript==

/* eslint-env es6 */
/* eslint no-var: "error" */
/* globals L, map */
/* globals GM_info, $, dialog */
/* globals renderPortalDetails, findPortalGuidByPositionE6 */


;(function() { // eslint-disable-line no-extra-semi

/** S2 Geometry functions

 S2 extracted from Regions Plugin
 https:static.iitc.me/build/release/plugins/regions.user.js

 the regional scoreboard is based on a level 6 S2 Cell
 - https:docs.google.com/presentation/d/1Hl4KapfAENAOf4gv-pSngKwvS_jwNVHRPZTTDzXXn6Q/view?pli=1#slide=id.i22
 at the time of writing there's no actual API for the intel map to retrieve scoreboard data,
 but it's still useful to plot the score cells on the intel map


 the S2 geometry is based on projecting the earth sphere onto a cube, with some scaling of face coordinates to
 keep things close to approximate equal area for adjacent cells
 to convert a lat,lng into a cell id:
 - convert lat,lng to x,y,z
 - convert x,y,z into face,u,v
 - u,v scaled to s,t with quadratic formula
 - s,t converted to integer i,j offsets
 - i,j converted to a position along a Hubbert space-filling curve
 - combine face,position to get the cell id

 NOTE: compared to the google S2 geometry library, we vary from their code in the following ways
 - cell IDs: they combine face and the hilbert curve position into a single 64 bit number. this gives efficient space
						 and speed. javascript doesn't have appropriate data types, and speed is not cricical, so we use
						 as [face,[bitpair,bitpair,...]] instead
 - i,j: they always use 30 bits, adjusting as needed. we use 0 to (1<<level)-1 instead
				(so GetSizeIJ for a cell is always 1)
*/

function wrapperPlugin(plugin_info) {
	'use strict';

	const d2r = Math.PI / 180.0;
	const r2d = 180.0 / Math.PI;

	const S2 = {};

	function LatLngToXYZ(latLng) {
		const phi = latLng.lat * d2r;
		const theta = latLng.lng * d2r;
		const cosphi = Math.cos(phi);

		return [Math.cos(theta) * cosphi, Math.sin(theta) * cosphi, Math.sin(phi)];
	}

	function XYZToLatLng(xyz) {
		const lat = Math.atan2(xyz[2], Math.sqrt(xyz[0] * xyz[0] + xyz[1] * xyz[1]));
		const lng = Math.atan2(xyz[1], xyz[0]);

		return {lat: lat * r2d, lng: lng * r2d};
	}

	function largestAbsComponent(xyz) {
		const temp = [Math.abs(xyz[0]), Math.abs(xyz[1]), Math.abs(xyz[2])];

		if (temp[0] > temp[1]) {
			if (temp[0] > temp[2]) {
				return 0;
			}
			return 2;
		}

		if (temp[1] > temp[2]) {
			return 1;
		}

		return 2;
	}

	function faceXYZToUV(face,xyz) {
		let u, v;

		switch (face) {
			case 0: u =	xyz[1] / xyz[0]; v =	xyz[2] / xyz[0]; break;
			case 1: u = -xyz[0] / xyz[1]; v =	xyz[2] / xyz[1]; break;
			case 2: u = -xyz[0] / xyz[2]; v = -xyz[1] / xyz[2]; break;
			case 3: u =	xyz[2] / xyz[0]; v =	xyz[1] / xyz[0]; break;
			case 4: u =	xyz[2] / xyz[1]; v = -xyz[0] / xyz[1]; break;
			case 5: u = -xyz[1] / xyz[2]; v = -xyz[0] / xyz[2]; break;
			default: throw {error: 'Invalid face'};
		}

		return [u,v];
	}

	function XYZToFaceUV(xyz) {
		let face = largestAbsComponent(xyz);

		if (xyz[face] < 0) {
			face += 3;
		}

		const uv = faceXYZToUV(face, xyz);

		return [face, uv];
	}

	function FaceUVToXYZ(face, uv) {
		const u = uv[0];
		const v = uv[1];

		switch (face) {
			case 0: return [1, u, v];
			case 1: return [-u, 1, v];
			case 2: return [-u,-v, 1];
			case 3: return [-1,-v,-u];
			case 4: return [v,-1,-u];
			case 5: return [v, u,-1];
			default: throw {error: 'Invalid face'};
		}
	}

	function STToUV(st) {
		const singleSTtoUV = function (st) {
			if (st >= 0.5) {
				return (1 / 3.0) * (4 * st * st - 1);
			}
			return (1 / 3.0) * (1 - (4 * (1 - st) * (1 - st)));

		};

		return [singleSTtoUV(st[0]), singleSTtoUV(st[1])];
	}

	function UVToST(uv) {
		const singleUVtoST = function (uv) {
			if (uv >= 0) {
				return 0.5 * Math.sqrt (1 + 3 * uv);
			}
			return 1 - 0.5 * Math.sqrt (1 - 3 * uv);

		};

		return [singleUVtoST(uv[0]), singleUVtoST(uv[1])];
	}

	function STToIJ(st,order) {
		const maxSize = 1 << order;

		const singleSTtoIJ = function (st) {
			const ij = Math.floor(st * maxSize);
			return Math.max(0, Math.min(maxSize - 1, ij));
		};

		return [singleSTtoIJ(st[0]), singleSTtoIJ(st[1])];
	}

	function IJToST(ij,order,offsets) {
		const maxSize = 1 << order;

		return [
			(ij[0] + offsets[0]) / maxSize,
			(ij[1] + offsets[1]) / maxSize
		];
	}

	// S2Cell class
	S2.S2Cell = function () {};

	//static method to construct
	S2.S2Cell.FromLatLng = function (latLng, level) {
		const xyz = LatLngToXYZ(latLng);
		const faceuv = XYZToFaceUV(xyz);
		const st = UVToST(faceuv[1]);
		const ij = STToIJ(st,level);

		return S2.S2Cell.FromFaceIJ(faceuv[0], ij, level);
	};

	S2.S2Cell.FromFaceIJ = function (face, ij, level) {
		const cell = new S2.S2Cell();
		cell.face = face;
		cell.ij = ij;
		cell.level = level;

		return cell;
	};

	S2.S2Cell.prototype.toString = function () {
		return 'F' + this.face + 'ij[' + this.ij[0] + ',' + this.ij[1] + ']@' + this.level;
	};

	S2.S2Cell.prototype.getLatLng = function () {
		const st = IJToST(this.ij, this.level, [0.5, 0.5]);
		const uv = STToUV(st);
		const xyz = FaceUVToXYZ(this.face, uv);

		return XYZToLatLng(xyz);
	};

	S2.S2Cell.prototype.getCornerLatLngs = function () {
		const offsets = [
			[0.0, 0.0],
			[0.0, 1.0],
			[1.0, 1.0],
			[1.0, 0.0]
		];

		return offsets.map(offset => {
			const st = IJToST(this.ij, this.level, offset);
			const uv = STToUV(st);
			const xyz = FaceUVToXYZ(this.face, uv);

			return XYZToLatLng(xyz);
		});
	};

	S2.S2Cell.prototype.getNeighbors = function (deltas) {

		const fromFaceIJWrap = function (face,ij,level) {
			const maxSize = 1 << level;
			if (ij[0] >= 0 && ij[1] >= 0 && ij[0] < maxSize && ij[1] < maxSize) {
				// no wrapping out of bounds
				return S2.S2Cell.FromFaceIJ(face,ij,level);
			}

			// the new i,j are out of range.
			// with the assumption that they're only a little past the borders we can just take the points as
			// just beyond the cube face, project to XYZ, then re-create FaceUV from the XYZ vector
			let st = IJToST(ij,level,[0.5, 0.5]);
			let uv = STToUV(st);
			let xyz = FaceUVToXYZ(face, uv);
			const faceuv = XYZToFaceUV(xyz);
			face = faceuv[0];
			uv = faceuv[1];
			st = UVToST(uv);
			ij = STToIJ(st,level);
			return S2.S2Cell.FromFaceIJ(face, ij, level);
		};

		const face = this.face;
		const i = this.ij[0];
		const j = this.ij[1];
		const level = this.level;

		if (!deltas) {
			deltas = [
				{a: -1, b: 0},
				{a: 0, b: -1},
				{a: 1, b: 0},
				{a: 0, b: 1}
			];
		}
		return deltas.map(function (values) {
			return fromFaceIJWrap(face, [i + values.a, j + values.b], level);
		});
	};

/** Our code
* For safety, S2 must be initialized before our code
*/

	// based on https://github.com/iatkin/leaflet-svgicon
	function initSvgIcon() {
		L.DivIcon.SVGIcon = L.DivIcon.extend({
			options: {
				'className': 'svg-icon',
				'iconAnchor': null, //defaults to [iconSize.x/2, iconSize.y] (point tip)
				'iconSize': L.point(48, 48)
			},
			initialize: function (options) {
				options = L.Util.setOptions(this, options);

				//iconSize needs to be converted to a Point object if it is not passed as one
				options.iconSize = L.point(options.iconSize);

				if (!options.iconAnchor) {
					options.iconAnchor = L.point(Number(options.iconSize.x) / 2, Number(options.iconSize.y));
				} else {
					options.iconAnchor = L.point(options.iconAnchor);
				}
			},

			// https://github.com/tonekk/Leaflet-Extended-Div-Icon/blob/master/extended.divicon.js#L13
			createIcon: function (oldIcon) {
				let div = L.DivIcon.prototype.createIcon.call(this, oldIcon);

				if (this.options.id) {
					div.id = this.options.id;
				}

				if (this.options.style) {
					for (let key in this.options.style) {
						div.style[key] = this.options.style[key];
					}
				}
				return div;
			}
		});

		L.divIcon.svgIcon = function (options) {
			return new L.DivIcon.SVGIcon(options);
		};

		L.Marker.SVGMarker = L.Marker.extend({
			options: {
				'iconFactory': L.divIcon.svgIcon,
				'iconOptions': {}
			},
			initialize: function (latlng, options) {
				options = L.Util.setOptions(this, options);
				options.icon = options.iconFactory(options.iconOptions);
				this._latlng = latlng;
			},
			onAdd: function (map) {
				L.Marker.prototype.onAdd.call(this, map);
			}
		});

		L.marker.svgMarker = function (latlng, options) {
			return new L.Marker.SVGMarker(latlng, options);
		};
	}

	/**
	 * Saves a file to disk with the provided text
	 * @param {string} text - The text to save
	 * @param {string} filename - Proposed filename
	 */
	function saveToFile(text, filename) {
		if (typeof text != 'string') {
			text = JSON.stringify(text);
		}

		if (typeof window.android !== 'undefined' && window.android.saveFile) {
			window.android.saveFile(filename, 'application/json', text);
			return;
		}

		if (isIITCm()) {
			promptForCopy(text);
			return;
		}

		const element = document.createElement('a');

		// http://stackoverflow.com/questions/13405129/javascript-create-and-save-file
		const file = new Blob([text], {type: 'text/plain'});
		const objectURL = URL.createObjectURL(file);
		element.setAttribute('href', objectURL);

		element.setAttribute('download', filename);

		element.style.display = 'none';
		document.body.appendChild(element);

		element.click();

		setTimeout(function() {
            document.body.removeChild(element);
            URL.revokeObjectURL(objectURL);
        }, 0);
	}

	/**
	 * Prompts the user to select a file and then reads its contents and calls the callback function with those contents
	 * @param {Function} callback - Function that will be called when the file is read.
	 * Callback signature: function( {string} contents ) {}
	 */
	function readFromFile(callback) {
		// special hook from iitcm
		if (typeof window.requestFile != 'undefined') {
			window.requestFile(function (filename, content) {
				callback(content);
			});
			return;
		}

		if (isIITCm()) {
			promptForPaste(callback);
			return;
		}

		const input = document.createElement('input');
		input.type = 'file';
		document.body.appendChild(input);

		input.addEventListener('change', function () {
			const reader = new FileReader();
			reader.onload = function () {
				callback(reader.result);
			};
			reader.readAsText(input.files[0]);
			document.body.removeChild(input);
		}, false);

		input.click();
	}

	function promptForPaste(callback) {
		const div = document.createElement('div');

		const textarea = document.createElement('textarea');
		textarea.style.width = '100%';
		textarea.style.minHeight = '8em';
		div.appendChild(textarea);

		const container = dialog({
			id: 'promptForPaste',
			html: div,
			width: '360px',
			title: 'Paste here the data',
			buttons: {
				OK: function () {
					container.dialog('close');
					callback(textarea.value);
				}
			}
		});
	}

	function promptForCopy(text) {
		const div = document.createElement('div');

		const textarea = document.createElement('textarea');
		textarea.style.width = '100%';
		textarea.style.minHeight = '8em';
		textarea.value = text;
		div.appendChild(textarea);

		const container = dialog({
			id: 'promptForCopy',
			html: div,
			width: '360px',
			title: 'Copy this data',
			buttons: {
				OK: function () {
					container.dialog('close');
				}
			}
		});
	}

	const TIMERS = {};
	function createThrottledTimer(name, callback, ms) {
		if (TIMERS[name])
			clearTimeout(TIMERS[name]);

		// throttle if there are several calls to the functions
		TIMERS[name] = setTimeout(function() {
			delete TIMERS[name];
			if (typeof window.requestIdleCallback == 'undefined')
				callback();
			else
				// and even now, wait for iddle
				requestIdleCallback(function() {
					callback();
				}, { timeout: 2000 });

		}, ms || 100);
	}

	/**
	 * Try to identify if the browser is IITCm due to special bugs like file picker not working
	 */
	function isIITCm() {
		const ua = navigator.userAgent;
		if (!ua.match(/Android.*Mobile/))
			return false;

		if (ua.match(/; wb\)/))
			return true;

		return ua.match(/ Version\//);
	}

	function is_iOS() {
		const ua = navigator.userAgent;
		return (ua.includes('iPhone') || ua.includes('iPad'))
	}

	let pokestops = {};
	let gyms = {};
	// Portals that aren't marked as PoGo items
	let notpogo = {};

	let allPortals = {};
	let newPortals = {};
	let checkNewPortalsTimer;
	let relayoutTimer; // timer for relayout when portal is added

	// Portals that the user hasn't classified as Pokestops (2 or more in the same Lvl17 cell)
	let skippedPortals = {};
	let newPokestops = {};
	let notClassifiedPokestops = [];

	// Portals that we know, but that have been moved from our stored location.
	let movedPortals = [];
	// Pogo items that are no longer available.
	let missingPortals = {};

	// Cells currently detected with extra gyms
	let cellsExtraGyms = {};
	// Cells that the user has marked to ignore extra gyms
	let ignoredCellsExtraGyms = {};
	// Cells with missing Gyms
	let ignoredCellsMissingGyms = {};

	// Leaflet layers
	let regionLayer; // parent layer
	let stopLayerGroup; // pokestops
	let gymLayerGroup; // gyms
	let nearbyLayerGroup; // circles to mark the too near limit
	let gridLayerGroup; // s2 grid
	let cellLayerGroup; // cell shading and borders
	let gymCenterLayerGroup; // gym centers

	// Group of items added to the layer
	let stopLayers = {};
	let gymLayers = {};
	let nearbyCircles = {};

	const gymCellLevel = 14; // the cell level which is considered when counting POIs to determine # of gyms
	const poiCellLevel = 17; // the cell level where there can only be 1 POI translated to pogo

	const defaultSettings = {
		highlightGymCandidateCells: true,
		highlightGymCenter: false,
		thisIsPogo: false,
		analyzeForMissingData: true,
		grids: [
			{
				level: gymCellLevel,
				width: 5,
				color: '#004D40',
				opacity: 0.5
			},
			{
				level: poiCellLevel,
				width: 2,
				color: '#388E3C',
				opacity: 0.5
			}
		],
		colors: {
			cellsExtraGyms: {
				color: '#ff0000',
				opacity: 0.5
			},
			cellsMissingGyms: {
				color: '#ffa500',
				opacity: 0.5
			},
			cell17Filled: {
				color: '#000000',
				opacity: 0.5
			},
			cell14Filled: {
				color: '#000000',
				opacity: 0.5
			},
			nearbyCircleBorder: {
				color: '#000000',
				opacity: 0.6
			},
			nearbyCircleFill: {
				color: '#000000',
				opacity: 0.4
			},
			missingStops1: {
				color: '#BF360C',
				opacity: 1
			},
			missingStops2: {
				color: '#E64A19',
				opacity: 1
			},
			missingStops3: {
				color: '#FF5722',
				opacity: 1
			}
		},
		saveDataType: 'Gyms',
		saveDataFormat: 'CSV'
	};

	let settings = defaultSettings;

	function saveSettings() {
		createThrottledTimer('saveSettings', function() {
			localStorage[KEY_SETTINGS] = JSON.stringify(settings);
		});
	}

	function loadSettings() {
		const tmp = localStorage[KEY_SETTINGS];
		if (!tmp) {
			loadOldSettings();
			return;
		}
		try	{
			settings = JSON.parse(tmp);
		} catch (e) { // eslint-disable-line no-empty
		}

		setThisIsPogo();
	}

	/**
	* Migrate from old key to new one in order to avoid conflict with other plugin that reused this code.
	*/
	function loadOldSettings() {
		const tmp = localStorage['s2check_settings'];
		if (!tmp)
			return;
		try	{
			settings = JSON.parse(tmp);
		} catch (e) { // eslint-disable-line no-empty
		}
		if (typeof settings.analyzeForMissingData == 'undefined') {
			settings.analyzeForMissingData = true;
		}
		if (typeof settings.promptForMissingData != 'undefined') {
			delete settings.promptForMissingData;
		}
		if (!settings.colors) {
			resetColors();
		}
		if (typeof settings.saveDataType == 'undefined') {
			settings.saveDataType = 'Gyms';
		}
		if (typeof settings.saveDataFormat == 'undefined') {
			settings.saveDataFormat = 'CSV';
		}

		setThisIsPogo();

		// migrate key
		localStorage.removeItem('s2check_settings');
		saveStorage();
	}

	function resetColors() {
		settings.grids[0].color = defaultSettings.grids[0].color;
		settings.grids[0].opacity = defaultSettings.grids[0].opacity;
		settings.grids[1].color = defaultSettings.grids[1].color;
		settings.grids[1].opacity = defaultSettings.grids[1].opacity;
		settings.colors = defaultSettings.colors;
	}

	let originalHighlightPortal;
	let originalChatRequestPublic;

	function setThisIsPogo() {
		document.body.classList[settings.thisIsPogo ? 'add' : 'remove']('thisIsPogo');
		// It seems that iOS has some bug in the following code, but I can't debug it.
		if (is_iOS())
			return;

		try
		{
			if (settings.thisIsPogo) {
				removeIngressLayers();
				if (chat && chat.requestPublic) {
					originalChatRequestPublic = chat && chat.requestPublic;
					chat.requestPublic = function() {}; // no requests for chat
				}

				if (window._current_highlighter == window._no_highlighter) {
					// extracted from IITC plugin: Hide portal ownership
					originalHighlightPortal = window.highlightPortal;
					window.highlightPortal = function(portal) {
						window.portalMarkerScale();
						const hidePortalOwnershipStyles = window.getMarkerStyleOptions({team: window.TEAM_NONE, level: 0});
						portal.setStyle(hidePortalOwnershipStyles);
					};
					window.resetHighlightedPortals();
				}
			} else {
				restoreIngressLayers();
				if (originalChatRequestPublic) {
					chat.requestPublic = originalChatRequestPublic;
					originalChatRequestPublic = null;
				}
				if (originalHighlightPortal != null) {
					window.highlightPortal = originalHighlightPortal;
					originalHighlightPortal = null;
					window.resetHighlightedPortals();
				}
			}
		}
		catch (e)
		{
			alert('Error initializing ThisIsPogo');
			console.log(e); // eslint-disable-line no-console
		}
	}

	function sortByName(a, b) {
		if (!a.name)
			return -1;

		return a.name.localeCompare(b.name);
	}

	function isCellOnScreen(mapBounds, cell) {
		const corners = cell.getCornerLatLngs();
		const cellBounds = L.latLngBounds([corners[0],corners[1]]).extend(corners[2]).extend(corners[3]);
		return cellBounds.intersects(mapBounds);
	}

	// return only the cells that are visible by the map bounds to ignore far away data that might not be complete
	function filterWithinScreen(cells) {
		const bounds = map.getBounds();
		const filtered = {};
		Object.keys(cells).forEach(cellId => {
			const cellData = cells[cellId];
			const cell = cellData.cell;

			if (isCellInsideScreen(bounds, cell)) {
				filtered[cellId] = cellData;
			}
		});
		return filtered;
	}

	function isCellInsideScreen(mapBounds, cell) {
		const corners = cell.getCornerLatLngs();
		const cellBounds = L.latLngBounds([corners[0],corners[1]]).extend(corners[2]).extend(corners[3]);
		return mapBounds.contains(cellBounds);
	}

	/**
	* Filter a group of items (gyms/stops) excluding those out of the screen
	*/
	function filterItemsByMapBounds(items) {
		const bounds = map.getBounds();
		const filtered = {};
		Object.keys(items).forEach(id => {
			const item = items[id];

			if (isPointOnScreen(bounds, item)) {
				filtered[id] = item;
			}
		});
		return filtered;
	}

	function isPointOnScreen(mapBounds, point) {
		if (point._latlng)
			return mapBounds.contains(point._latlng);

		return mapBounds.contains(L.latLng(point));
	}

	function groupByCell(level) {
		const cells = {};
		classifyGroup(cells, gyms, level, (cell, item) => cell.gyms.push(item));
		classifyGroup(cells, pokestops, level, (cell, item) => cell.stops.push(item));
		classifyGroup(cells, newPortals, level, (cell, item) => cell.notClassified.push(item));
		classifyGroup(cells, notpogo, level, (cell, item) => {/* */});

		return cells;
	}

	function classifyGroup(cells, items, level, callback) {
		Object.keys(items).forEach(id => {
			const item = items[id];
			if (!item.cells) {
				item.cells = {};
			}
			let cell;
			// Compute the cell only once for each level
			if (!item.cells[level]) {
				cell = S2.S2Cell.FromLatLng(item, level);
				item.cells[level] = cell.toString();
			}
			const cellId = item.cells[level];

			// Add it to the array of gyms of that cell
			if (!cells[cellId]) {
				if (!cell) {
					cell = S2.S2Cell.FromLatLng(item, level);
				}
				cells[cellId] = {
					cell: cell,
					gyms: [],
					stops: [],
					notClassified: []
				};
			}
			callback(cells[cellId], item);
		});
	}

	/**
	 * Returns the items that belong to the specified cell
	 */
	function findCellItems(cellId, level, items) {
		return Object.values(items).filter(item => item.cells[level] == cellId);
	}

	/**
		Tries to add the portal photo when exporting from Ingress.com/intel
	*/
	function findPhotos(items) {
		if (!window.portals) {
			return items;
		}
		Object.keys(items).forEach(id => {
			const item = items[id];
			if (item.image)
				return;

			const portal = window.portals[id];
			if (portal && portal.options && portal.options.data) {
				item.image = portal.options.data.image;
			}
		});
		return items;
	}

	function configureGridLevelSelect(select, i) {
		select.value = settings.grids[i].level;
		select.addEventListener('change', e => {
			settings.grids[i].level = parseInt(select.value, 10);
			saveSettings();
			updateMapGrid();
		});
	}

	function showS2Dialog() {
		const selectRow = `
			<p>{{level}} 셀을 지도에 그리기: <select>
			<option value=0>None</option>
			<option value=6>6</option>
			<option value=7>7</option>
			<option value=8>8</option>
			<option value=9>9</option>
			<option value=10>10</option>
			<option value=11>11</option>
			<option value=12>12</option>
			<option value=13>13</option>
			<option value=14>14</option>
			<option value=15>15</option>
			<option value=16>16</option>
			<option value=17>17</option>
			<option value=18>18</option>
			<option value=19>19</option>
			<option value=20>20</option>
			</select></p>`;

		const html =
			selectRow.replace('{{level}}', '첫번째') +
			selectRow.replace('{{level}}', '두번째') +
			`<p><input type="checkbox" id="chkHighlightCandidates" /><label for="chkHighlightCandidates">포탈 셀 확인</label></p>
			 <p><input type="checkbox" id="chkHighlightCenters" /><label for="chkHighlightCenters">무조건 체크해제<br />(for determining EX-eligibility)</label></p>
			 <p><input type="checkbox" id="chkThisIsPogo" /><label for="chkThisIsPogo" title='Hide Ingress panes, info and whatever that clutters the map and it is useless for Pokemon Go'>포고 모드</label></p>
			 <p><input type="checkbox" id="chkanalyzeForMissingData" /><label for="chkanalyzeForMissingData" title="Analyze the portal data to show the pane that suggests new Pokestops and Gyms">스탑 및 체육관 생성 분석</label></p>
			 <p><a id='PogoEditColors'>색상 설정</a></p>
			`;

		const container = dialog({
			id: 's2Settings',
			width: 'auto',
			html: html,
			title: 'S2 & 포고 셋팅'
		});

		const div = container[0];

		const selects = div.querySelectorAll('select');
		for (let i = 0; i < 2; i++) {
			configureGridLevelSelect(selects[i], i);
		}

		const chkHighlight = div.querySelector('#chkHighlightCandidates');
		chkHighlight.checked = settings.highlightGymCandidateCells;

		chkHighlight.addEventListener('change', e => {
			settings.highlightGymCandidateCells = chkHighlight.checked;
			saveSettings();
			updateMapGrid();
		});

		const chkHighlightCenters = div.querySelector('#chkHighlightCenters');
		chkHighlightCenters.checked = settings.highlightGymCenter;
		chkHighlightCenters.addEventListener('change', e => {
			settings.highlightGymCenter = chkHighlightCenters.checked;
			saveSettings();
			updateMapGrid();
		});

		const chkThisIsPogo = div.querySelector('#chkThisIsPogo');
		chkThisIsPogo.checked = !!settings.thisIsPogo;
		chkThisIsPogo.addEventListener('change', e => {
			settings.thisIsPogo = chkThisIsPogo.checked;
			saveSettings();
			setThisIsPogo();
		});

		const chkanalyzeForMissingData = div.querySelector('#chkanalyzeForMissingData');
		chkanalyzeForMissingData.checked = !!settings.analyzeForMissingData;
		chkanalyzeForMissingData.addEventListener('change', e => {
			settings.analyzeForMissingData = chkanalyzeForMissingData.checked;
			saveSettings();
			if (newPortals.length > 0) {
				checkNewPortals();
			}
		});

		const PogoEditColors = div.querySelector('#PogoEditColors');
		PogoEditColors.addEventListener('click', function (e) {
			editColors();
			e.preventDefault();
			return false;
		});
	}

	function editColors() {
		const selectRow = `<p class='pogo-colors'>{{title}}<br>
			Color: <input type='color' id='{{id}}Color'> 투명도: <select id='{{id}}Opacity'>
			<option value=0>0</option>
			<option value=0.1>0.1</option>
			<option value=0.2>0.2</option>
			<option value=0.3>0.3</option>
			<option value=0.4>0.4</option>
			<option value=0.5>0.5</option>
			<option value=0.6>0.6</option>
			<option value=0.7>0.7</option>
			<option value=0.8>0.8</option>
			<option value=0.9>0.9</option>
			<option value=1>1</option>
            </select>{{width}}</p>`;

		const html =
			selectRow.replace('{{title}}', '셀 색상 선택1').replace(`{{width}}`, ` 굵기: <input type='number' min='1' max='8' id='{{id}}Width' size='2'> `).replace(/{{id}}/g, 'grid0') +
			selectRow.replace('{{title}}', '셀 색상 선택2').replace(`{{width}}`, ` 굵긴: <input type='number' min='1' max='8' id='{{id}}Width' size='2'> `).replace(/{{id}}/g, 'grid1') +
			selectRow.replace('{{title}}', '셀내 규칙보다 체육관 숫자 초과').replace(/{{id}}/g, 'cellsExtraGyms').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', '어딘가에 체육관 생성되야 함').replace(/{{id}}/g, 'cellsMissingGyms').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', `Cell ${poiCellLevel}셀에서 스탑이나 체육관이 있는 셀`).replace(/{{id}}/g, 'cell17Filled').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', `Cell ${gymCellLevel}셀에서 체육관 3개 생성된 셀`).replace(/{{id}}/g, 'cell14Filled').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', '20m 원 그리기').replace(/{{id}}/g, 'nearbyCircleBorder').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', '20m 원 채우기').replace(/{{id}}/g, 'nearbyCircleFill').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', '스탑 1개 추가되면 체육관 생성').replace(/{{id}}/g, 'missingStops1').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', '스탑 2개 추가되면 체육관 생성').replace(/{{id}}/g, 'missingStops2').replace(`{{width}}`, '') +
			selectRow.replace('{{title}}', '스탑 3개 추가되면 체육관 생성').replace(/{{id}}/g, 'missingStops3').replace(`{{width}}`, '') +
			'<a id="resetColorsLink">모든 색상 설정 초기화</a>'
			;

		const container = dialog({
			id: 's2Colors',
			width: 'auto',
			html: html,
			title: '색상 설정'
		});

		const div = container[0];

		const updatedSetting = function (id) {
			saveSettings();
			if (id == 'nearbyCircleBorder' || id == 'nearbyCircleFill') {
				redrawNearbyCircles();
			} else {
				updateMapGrid();
			}
		};

		const configureItems = function (key, item, id) {
			if (!id)
				id = item;

			const entry = settings[key][item];
			const select = div.querySelector('#' + id + 'Opacity');
			select.value = entry.opacity;
			select.addEventListener('change', function (event) {
				settings[key][item].opacity = select.value;
				updatedSetting(id);
			});

			const input = div.querySelector('#' + id + 'Color');
			input.value = entry.color;
			input.addEventListener('change', function (event) {
				settings[key][item].color = input.value;
				updatedSetting(id);
			});

			if (entry.width != null) {
				const widthInput = div.querySelector('#' + id + 'Width');
				widthInput.value = entry.width;
				widthInput.addEventListener('change', function (event) {
					settings[key][item].width = widthInput.value;
					updatedSetting(id);
				});
            }
		};

		configureItems('grids', 0, 'grid0');
		configureItems('grids', 1, 'grid1');
		configureItems('colors', 'cellsExtraGyms');
		configureItems('colors', 'cellsMissingGyms');
		configureItems('colors', 'cell17Filled');
		configureItems('colors', 'cell14Filled');
		configureItems('colors', 'nearbyCircleBorder');
		configureItems('colors', 'nearbyCircleFill');
		configureItems('colors', 'missingStops1');
		configureItems('colors', 'missingStops2');
		configureItems('colors', 'missingStops3');

		const resetColorsLink = div.querySelector('#resetColorsLink');
		resetColorsLink.addEventListener('click', function() {
			container.dialog('close');
			resetColors();
			updatedSetting('nearbyCircleBorder');
			updatedSetting();
			editColors();
		});
	}

	/**
	 * Refresh the S2 grid over the map
	 */
	function updateMapGrid() {
		// preconditions
		if (!map.hasLayer(regionLayer)) {
			return;
		}
		const zoom = map.getZoom();

		// first draw nearby circles at the bottom
		if (zoom > 16) {
			if (!regionLayer.hasLayer(nearbyLayerGroup)) {
				regionLayer.addLayer(nearbyLayerGroup);
			}
			nearbyLayerGroup.bringToBack();
		} else if (regionLayer.hasLayer(nearbyLayerGroup)) {
			regionLayer.removeLayer(nearbyLayerGroup);
		}

		// shade level 14 and level 17 cells
		let cellsCloseToThreshold;
		if (settings.highlightGymCandidateCells && zoom > 14) {
			cellsCloseToThreshold = updateCandidateCells(zoom);
			if (!regionLayer.hasLayer(cellLayerGroup)) {
				regionLayer.addLayer(cellLayerGroup);
			}
			cellLayerGroup.bringToBack();
		} else if (regionLayer.hasLayer(cellLayerGroup)) {
			regionLayer.removeLayer(cellLayerGroup);
		}

		// then draw the cell grid
		if (zoom > 4) {
			drawCellGrid(zoom);

			// update cell grid with cells close to a threshold for a gym
			if (cellsCloseToThreshold) {
				// draw missing cells in reverse order
				for (let missingStops = 3; missingStops >= 1; missingStops--) {
					const color = settings.colors['missingStops' + missingStops].color;
					const opacity = settings.colors['missingStops' + missingStops].opacity;
					cellsCloseToThreshold[missingStops].forEach(cell => gridLayerGroup.addLayer(drawCell(cell, color, 3, opacity)));
				}
			}

			if (!regionLayer.hasLayer(gridLayerGroup)) {
				regionLayer.addLayer(gridLayerGroup);
			}
		} else if (regionLayer.hasLayer(gridLayerGroup)) {
			regionLayer.removeLayer(gridLayerGroup);
		}

		// update gym centers
		if (settings.highlightGymCenter && zoom > 16) {
			updateGymCenters();
			if (!regionLayer.hasLayer(gymCenterLayerGroup)) {
				regionLayer.addLayer(gymCenterLayerGroup);
			}
		} else if (regionLayer.hasLayer(gymCenterLayerGroup)) {
			regionLayer.removeLayer(gymCenterLayerGroup);
		}
	}

	function getLatLngPoint(data) {
		const result = {
			lat: typeof data.lat == 'function' ? data.lat() : data.lat,
			lng: typeof data.lng == 'function' ? data.lng() : data.lng
		};

		return result;
	}

	/**
	 * Highlight cells that are missing a few stops to get another gym. Also fills level 17 cells with a stop/gym.
	 * based on data from https://www.reddit.com/r/TheSilphRoad/comments/7ppb3z/gyms_pok%C3%A9stops_and_s2_cells_followup_research/
	 * Cut offs: 2, 6, 20
	 */
	function updateCandidateCells(zoom) {
		cellLayerGroup.clearLayers();

		// All cells with items
		const allCells = groupByCell(gymCellLevel);

		const bounds = map.getBounds();
		const seenCells = {};
		const cellsCloseToThreshold = {
			1: [],
			2: [],
			3: []
		};

		const drawCellAndNeighbors = function (cell) {
			const cellStr = cell.toString();

			if (!seenCells[cellStr]) {
				// cell not visited - flag it as visited now
				seenCells[cellStr] = true;

				if (isCellOnScreen(bounds, cell)) {
					// on screen - draw it
					const cellData = allCells[cellStr];
					if (cellData) {
						// check for errors
						const missingGyms = computeMissingGyms(cellData);
						if (missingGyms > 0 && !ignoredCellsMissingGyms[cellStr]) {
							cellLayerGroup.addLayer(fillCell(cell, settings.colors.cellsMissingGyms.color, settings.colors.cellsMissingGyms.opacity));
						} else if (missingGyms < 0 && !ignoredCellsExtraGyms[cellStr]) {
							cellLayerGroup.addLayer(fillCell(cell, settings.colors.cellsExtraGyms.color, settings.colors.cellsExtraGyms.opacity));
							if (!cellsExtraGyms[cellStr]) {
								cellsExtraGyms[cellStr] = true;
								updateCounter('extraGyms', Object.keys(cellsExtraGyms));
							}
						}

						// shade filled level 17 cells
						if (zoom > 15) {
							const coverLevel17Cell = function(point) {
								const cell = S2.S2Cell.FromLatLng(point, poiCellLevel);
								cellLayerGroup.addLayer(fillCell(cell, settings.colors.cell17Filled.color, settings.colors.cell17Filled.opacity));
							};

							cellData.gyms.forEach(coverLevel17Cell);
							cellData.stops.forEach(coverLevel17Cell);
						}

						// number of stops to next gym
						const missingStops = computeMissingStops(cellData);
                        const totalStops = couputeTotalStops(cellData); // 추가된 함수
						switch (missingStops) {
							case 0:
								if (missingGyms <= 0) {
									cellLayerGroup.addLayer(fillCell(cell, settings.colors.cell14Filled.color, settings.colors.cell14Filled.opacity));
                                    cellLayerGroup.addLayer(writeInCell(cell, totalStops));
								}
								break;
							case 1:
							case 2:
							case 3:
								cellsCloseToThreshold[missingStops].push(cell);
								cellLayerGroup.addLayer(writeInCell(cell, missingStops));
								break;
							default:
								cellLayerGroup.addLayer(writeInCell(cell, missingStops));
								break;
						}
					}

					// and recurse to our neighbors
					const neighbors = cell.getNeighbors();
					for (let i = 0; i < neighbors.length; i++) {
						drawCellAndNeighbors(neighbors[i]);
					}
				}
			}
		};

		const cell = S2.S2Cell.FromLatLng(getLatLngPoint(map.getCenter()), gymCellLevel);
		drawCellAndNeighbors(cell);

		return cellsCloseToThreshold;
	}

	function drawCellGrid(zoom) {
		// clear, to redraw
		gridLayerGroup.clearLayers();

		const bounds = map.getBounds();
		const seenCells = {};
		const drawCellAndNeighbors = function (cell, color, width, opacity) {
			const cellStr = cell.toString();

			if (!seenCells[cellStr]) {
				// cell not visited - flag it as visited now
				seenCells[cellStr] = true;

				if (isCellOnScreen(bounds, cell)) {
					// on screen - draw it
					gridLayerGroup.addLayer(drawCell(cell, color, width, opacity));

					// and recurse to our neighbors
					const neighbors = cell.getNeighbors();
					for (let i = 0; i < neighbors.length; i++) {
						drawCellAndNeighbors(neighbors[i], color, width, opacity);
					}
				}
			}
		};

		for (let i = settings.grids.length - 1; i >= 0; --i) {
			const grid = settings.grids[i];
			const gridLevel = grid.level;
			if (gridLevel >= 6 && gridLevel < (zoom + 2)) {
				const cell = S2.S2Cell.FromLatLng(getLatLngPoint(map.getCenter()), gridLevel);
				drawCellAndNeighbors(cell, grid.color, grid.width, grid.opacity);
			}
		}

		return gridLayerGroup;
	}

	/**
	 * Draw a cross to the center of level 20 cells that have a Gym to check better EX locations
	 */
	function updateGymCenters() {
		// clear
		gymCenterLayerGroup.clearLayers();

		const visibleGyms = filterItemsByMapBounds(gyms);
		const level = 20;

		Object.keys(visibleGyms).forEach(id => {
			const gym = gyms[id];
			const cell = S2.S2Cell.FromLatLng(gym, level);
			const corners = cell.getCornerLatLngs();
			// center point
			const center = cell.getLatLng();

			const style = {fill: false, color: 'red', opacity: 0.8, weight: 1, clickable: false, interactive: false};
			const line1 = L.polyline([corners[0], corners[2]], style);
			gymCenterLayerGroup.addLayer(line1);

			const line2 = L.polyline([corners[1], corners[3]], style);
			gymCenterLayerGroup.addLayer(line2);

			const circle = L.circle(center, 1, style);
			gymCenterLayerGroup.addLayer(circle);
		});
	}

	// Computes how many new stops must be added to the L14 Cell to get a new Gym
	function computeMissingStops(cellData) {
		const gyms = cellData.gyms.length;
		const stops = cellData.stops.length;
		const sum = gyms + stops;
		if (sum < 2 && gyms == 0)
			return 2 - sum;

		if (sum < 6 && gyms < 2)
			return 6 - sum;

		if (sum < 20 && gyms < 3)
			return 20 - sum;

		// No options to more gyms ATM.
		return 0;
	}

    // 추가 한 토탈 스탑수 함수
    function couputeTotalStops(cellData) {
        const totalGyms = cellData.gyms.length;
        const totalStops = cellData.stops.length;
        const totalSum = totalGyms + totalStops;

        return totalSum;
    }

	// Checks if the L14 cell has enough Gyms and Stops and one of the stops should be marked as a Gym
	// If the result is negative then it has extra gyms
	function computeMissingGyms(cellData) {
		const totalGyms = cellData.gyms.length;
		const sum = totalGyms + cellData.stops.length;

		if (sum < 2)
			return 0 - totalGyms;

		if (sum < 6)
			return 1 - totalGyms;

		if (sum < 20)
			return 2 - totalGyms;

		return 3 - totalGyms;
	}

	function drawCell(cell, color, weight, opacity) {
		// corner points
		const corners = cell.getCornerLatLngs();

		// the level 6 cells have noticible errors with non-geodesic lines - and the larger level 4 cells are worse
		// NOTE: we only draw two of the edges. as we draw all cells on screen, the other two edges will either be drawn
		// from the other cell, or be off screen so we don't care
		const region = L.polyline([corners[0], corners[1], corners[2], corners[3], corners[0]], {fill: false, color: color, opacity: opacity, weight: weight, clickable: false, interactive: false});

		return region;
	}

	function fillCell(cell, color, opacity) {
		// corner points
		const corners = cell.getCornerLatLngs();

		const region = L.polygon(corners, {color: color, fillOpacity: opacity, weight: 0, clickable: false, interactive: false});

		return region;
	}

	/**
	*	Writes a text in the center of a cell
	*/
	function writeInCell(cell, text) {
		// center point
		let center = cell.getLatLng();

		let marker = L.marker(center, {
			icon: L.divIcon({
				className: 'pogo-text',
				iconAnchor: [25, 5],
				iconSize: [50, 10],
				html: text
			}),
			interactive: false
		});
		// fixme, maybe add some click handler

		return marker;
	}

	// ***************************
	// IITC code
	// ***************************

	// ensure plugin framework is there, even if iitc is not yet loaded
	if (typeof window.plugin !== 'function') {
		window.plugin = function () {};
	}

	// PLUGIN START

	// use own namespace for plugin
	window.plugin.pogo = function () {};

	const thisPlugin = window.plugin.pogo;
	const KEY_STORAGE = 'plugin-pogo';
	const KEY_SETTINGS = 'plugin-pogo-settings';

	// Update the localStorage
	function saveStorage() {
		createThrottledTimer('saveStorage', function() {
			localStorage[KEY_STORAGE] = JSON.stringify({
				gyms: cleanUpExtraData(gyms),
				pokestops: cleanUpExtraData(pokestops),
				notpogo: cleanUpExtraData(notpogo),
				ignoredCellsExtraGyms: ignoredCellsExtraGyms,
				ignoredCellsMissingGyms: ignoredCellsMissingGyms
			});
		});
	}

	/**
	 * Create a new object where the extra properties of each pokestop/gym have been removed. Store only the minimum.
	 */
	function cleanUpExtraData(group) {
		let newGroup = {};
		Object.keys(group).forEach(id => {
			const data = group[id];
			const newData = {
				guid: data.guid,
				lat: data.lat,
				lng: data.lng,
				name: data.name
			};

			if (data.isEx)
				newData.isEx = data.isEx;

			if (data.medal)
				newData.medal = data.medal;

			newGroup[id] = newData;
		});
		return newGroup;
	}

	// Load the localStorage
	thisPlugin.loadStorage = function () {
		const tmp = JSON.parse(localStorage[KEY_STORAGE] || '{}');
		gyms = tmp.gyms || {};
		pokestops = tmp.pokestops || {};
		notpogo = tmp.notpogo || {};
		ignoredCellsExtraGyms = tmp.ignoredCellsExtraGyms || {};
		ignoredCellsMissingGyms = tmp.ignoredCellsMissingGyms || {};
	};

	thisPlugin.createEmptyStorage = function () {
		gyms = {};
		pokestops = {};
		notpogo = {};
		ignoredCellsExtraGyms = {};
		ignoredCellsMissingGyms = {};
		saveStorage();

		allPortals = {};
		newPortals = {};

		movedPortals = [];
		missingPortals = {};
	};

	/*************************************************************************/

	thisPlugin.findByGuid = function (guid) {
		if (gyms[guid]) {
			return {'type': 'gyms', 'store': gyms};
		}
		if (pokestops[guid]) {
			return {'type': 'pokestops', 'store': pokestops};
		}
		if (notpogo[guid]) {
			return {'type': 'notpogo', 'store': notpogo};
		}
		return null;
	};

	// Append a 'star' flag in sidebar.
	thisPlugin.onPortalSelectedPending = false;
	thisPlugin.onPortalSelected = function () {
		$('.pogoStop').remove();
		$('.pogoGym').remove();
		$('.notPogo').remove();
		const portalDetails = document.getElementById('portaldetails');
		portalDetails.classList.remove('isGym');

		if (window.selectedPortal == null) {
			return;
		}

		if (!thisPlugin.onPortalSelectedPending) {
			thisPlugin.onPortalSelectedPending = true;

			setTimeout(function () { // the sidebar is constructed after firing the hook
				thisPlugin.onPortalSelectedPending = false;

				$('.pogoStop').remove();
				$('.pogoGym').remove();
				$('.notPogo').remove();

				// Show PoGo icons in the mobile status-bar
				if (thisPlugin.isSmart) {
					document.querySelector('.PogoStatus').innerHTML = thisPlugin.htmlStar;
					$('.PogoStatus > a').attr('title', '');
				}

				$(portalDetails).append('<div class="PogoButtons">Pokemon Go: ' + thisPlugin.htmlStar + '</div>' +
					`<div id="PogoGymInfo">
					<label for='PogoGymMedal'>체육관 메달:</label> <select id='PogoGymMedal'>
							<option value='None'>메달 없음</option>
							<option value='Bronze'>동메달</option>
							<option value='Silver'>은메달</option>
							<option value='Gold'>금메달</option>
							</select><br>
					<label>EX 체육관? <input type='checkbox' id='PogoGymEx'> Yes</label><br>
				</div>`);

				document.getElementById('PogoGymMedal').addEventListener('change', ev => {
					const guid = window.selectedPortal;
					const icon = document.getElementById('gym' + guid.replace('.', ''));
					// remove styling of gym marker
					if (icon) {
						icon.classList.remove(gyms[guid].medal + 'Medal');
					}
					gyms[guid].medal = ev.target.value;
					saveStorage();
					// update gym marker
					if (icon) {
						icon.classList.add(gyms[guid].medal + 'Medal');
					}
				});

				document.getElementById('PogoGymEx').addEventListener('change', ev => {
					const guid = window.selectedPortal;
					const icon = document.getElementById('gym' + guid.replace('.', ''));
					gyms[guid].isEx = ev.target.checked;
					saveStorage();
					// update gym marker
					if (icon) {
						icon.classList[gyms[guid].isEx ? 'add' : 'remove']('exGym');
					}
				});

				thisPlugin.updateStarPortal();
			}, 0);
		}
	};

	// Update the status of the star (when a portal is selected from the map/pogo-list)
	thisPlugin.updateStarPortal = function () {
		$('.pogoStop').removeClass('favorite');
		$('.pogoGym').removeClass('favorite');
		$('.notPogo').removeClass('favorite');
		document.getElementById('portaldetails').classList.remove('isGym');

		const guid = window.selectedPortal;
		// If current portal is into pogo: select pogo portal from portals list and select the star
		const pogoData = thisPlugin.findByGuid(guid);
		if (pogoData) {
			if (pogoData.type === 'pokestops') {
				$('.pogoStop').addClass('favorite');
			}
			if (pogoData.type === 'gyms') {
				$('.pogoGym').addClass('favorite');
				document.getElementById('portaldetails').classList.add('isGym');
				const gym = gyms[guid];
				if (gym.medal) {
					document.getElementById('PogoGymMedal').value = gym.medal;
				}
				document.getElementById('PogoGymEx').checked = gym.isEx;

			}
			if (pogoData.type === 'notpogo') {
				$('.notPogo').addClass('favorite');
			}
		}
	};

	function removePogoObject(type, guid) {
		if (type === 'pokestops') {
			delete pokestops[guid];
			const starInLayer = stopLayers[guid];
			stopLayerGroup.removeLayer(starInLayer);
			delete stopLayers[guid];
		}
		if (type === 'gyms') {
			delete gyms[guid];
			const gymInLayer = gymLayers[guid];
			gymLayerGroup.removeLayer(gymInLayer);
			delete gymLayers[guid];
		}
		if (type === 'notpogo') {
			delete notpogo[guid];
		}
	}

	// Switch the status of the star
	thisPlugin.switchStarPortal = function (type) {
		const guid = window.selectedPortal;

		// It has been manually classified, remove from the detection
		if (newPortals[guid])
			delete newPortals[guid];

		// If portal is saved in pogo: Remove this pogo
		const pogoData = thisPlugin.findByGuid(guid);
		if (pogoData) {
			const existingType = pogoData.type;
			removePogoObject(existingType, guid);

			saveStorage();
			thisPlugin.updateStarPortal();

			// Get portal name and coordinates
			const p = window.portals[guid];
			const ll = p.getLatLng();
			if (existingType !== type) {
				thisPlugin.addPortalpogo(guid, ll.lat, ll.lng, p.options.data.title, type);
			}
			// we've changed one item from pogo, if the cell was marked as ignored, reset it.
			if (updateExtraGymsCells(ll.lat, ll.lng))
				saveStorage();
		} else {
			// If portal isn't saved in pogo: Add this pogo

			// Get portal name and coordinates
			const portal = window.portals[guid];
			const latlng = portal.getLatLng();
			thisPlugin.addPortalpogo(guid, latlng.lat, latlng.lng, portal.options.data.title, type);
		}

		if (settings.highlightGymCandidateCells) {
			updateMapGrid();
		}
	};

	// Add portal
	thisPlugin.addPortalpogo = function (guid, lat, lng, name, type) {
		// Add pogo in the localStorage
		const obj = {'guid': guid, 'lat': lat, 'lng': lng, 'name': name};

		// prevent that it would trigger the missing portal detection if it's in our data
		if (window.portals[guid]) {
			obj.exists = true;
		}

		if (type == 'gyms') {
			gyms[guid] = obj;
		}
		if (type == 'pokestops') {
			pokestops[guid] = obj;
		}
		if (type == 'notpogo') {
			notpogo[guid] = obj;
		}

		updateExtraGymsCells(lat, lng);
		saveStorage();
		thisPlugin.updateStarPortal();

		thisPlugin.addStar(guid, lat, lng, name, type);
	};

	/**
	 * An item has been changed in a cell, check if the cell should no longer be ignored
	 */
	function updateExtraGymsCells(lat, lng) {
		if (Object.keys(ignoredCellsExtraGyms).length == 0 && Object.keys(ignoredCellsMissingGyms).length == 0)
			return false;

		const cell = S2.S2Cell.FromLatLng(new L.LatLng(lat, lng), gymCellLevel);
		const cellId = cell.toString();
		if (ignoredCellsExtraGyms[cellId]) {
			delete ignoredCellsExtraGyms[cellId];
			return true;
		}
		if (ignoredCellsMissingGyms[cellId]) {
			delete ignoredCellsMissingGyms[cellId];
			return true;
		}
		return false;
	}

	/*
		OPTIONS
	*/
	// Manual import, export and reset data
	thisPlugin.pogoActionsDialog = function () {
		const content = `<div id="pogoSetbox">
			<a id="save-dialog" title="Select the data to save from the info on screen">저장</a>
			<a onclick="window.plugin.pogo.optReset();return false;" title="Deletes all Pokemon Go markers">포고 정보 초기화</a>
			<a onclick="window.plugin.pogo.optImport();return false;" title="Import a JSON file with all the PoGo data">데이터 넣기</a>
			<a onclick="window.plugin.pogo.optExport();return false;" title="Exports a JSON file with all the PoGo data">데이터 내보내기</a>
			</div>`;

		const container = dialog({
			html: content,
			title: '셀 데이터 설정'
		});

		const div = container[0];
		div.querySelector('#save-dialog').addEventListener('click', e => saveDialog());
	};

	function saveDialog() {
		const content = `<div>
			<p>Select the data to save from the info on screen</p>
			<fieldset><legend>Which data?</legend>
			<input type='radio' name='PogoSaveDataType' value='Gyms' id='PogoSaveDataTypeGyms'><label for='PogoSaveDataTypeGyms'>Gyms</label><br>
			<input type='radio' name='PogoSaveDataType' value='PokeStopsGyms' id='PogoSaveDataTypePokeStopsGyms'><label for='PogoSaveDataTypePokeStopsGyms'>Pokestops + Gyms</label>
			</fieldset>
			<fieldset><legend>Format</legend>
			<input type='radio' name='PogoSaveDataFormat' value='CSV' id='PogoSaveDataFormatCSV'><label for='PogoSaveDataFormatCSV'>CSV</label><br>
			<input type='radio' name='PogoSaveDataFormat' value='JSON' id='PogoSaveDataFormatJSON'><label for='PogoSaveDataFormatJSON'>JSON</label>
			</fieldset>
			</div>`;

		const container = dialog({
			html: content,
			title: 'Save visible data',
			buttons: {
				'Save': function () {
					const SaveDataType = document.querySelector('input[name="PogoSaveDataType"]:checked').value;
					const SaveDataFormat = document.querySelector('input[name="PogoSaveDataFormat"]:checked').value;

					settings.saveDataType = SaveDataType;
					settings.saveDataFormat = SaveDataFormat;
					saveSettings();

					container.dialog('close');

					let filename = (SaveDataType == 'Gyms' ? 'gyms_' : 'gyms+stops_') + (new Date()).toISOString().substr(0, 19).replace(/[\D]/g, '_');
					if (SaveDataFormat == 'CSV') {
						filename += '.csv';
						const allData = SaveDataType == 'Gyms' ? gyms : Object.assign({}, gyms, pokestops);
						const data = filterItemsByMapBounds(allData);
						const keys = Object.keys(data);
						const contents = keys.map(id => {
							const gym = data[id];
							return (gym.name ? gym.name.replace(/,/g, ' ') + ',' : '') + gym.lat + ',' + gym.lng;
						});

						saveToFile(contents.join('\n'), filename);
					} else {
						filename += '.json';
						const data = {
							gyms: findPhotos(cleanUpExtraData(filterItemsByMapBounds(gyms))),
						};
						if (SaveDataType != 'Gyms')
							data.pokestops = findPhotos(cleanUpExtraData(filterItemsByMapBounds(pokestops)));

						saveToFile(JSON.stringify(data), filename);
					}
				}
			}

		});

		// Remove ok button
		const outer = container.parent();
		outer.find('.ui-dialog-buttonset button:first').remove();

		const div = container[0];
		div.querySelector('#PogoSaveDataType' + settings.saveDataType).checked = true;
		div.querySelector('#PogoSaveDataFormat' + settings.saveDataFormat).checked = true;

	};

	thisPlugin.optAlert = function (message) {
		$('.ui-dialog .ui-dialog-buttonset').prepend('<p class="pogo-alert" style="float:left;margin-top:4px;">' + message + '</p>');
		$('.pogo-alert').delay(2500).fadeOut();
	};

	thisPlugin.optExport = function () {
		saveToFile(localStorage[KEY_STORAGE], 'IITC-pogo.json');
	};

	thisPlugin.optImport = function () {
		readFromFile(function (content) {
			try {
				const list = JSON.parse(content); // try to parse JSON first
				let importExStatus = true;
				let importGymMedal = true;
				Object.keys(list).forEach(type => {
					for (let idpogo in list[type]) {
						const item = list[type][idpogo];
						const lat = item.lat;
						const lng = item.lng;
						const name = item.name;
						let guid = item.guid;
						if (!guid) {
							guid = findPortalGuidByPositionE6(lat * 1E6, lng * 1E6);
							if (!guid) {
								console.log('portal guid not found', name, lat, lng); // eslint-disable-line no-console
								guid = idpogo;
							}
						}

						if (typeof lat !== "undefined" && typeof lng !== "undefined" && name && !thisPlugin.findByGuid(guid)) {
							thisPlugin.addPortalpogo(guid, lat, lng, name, type);
							if (type == 'gyms') {
								if (importExStatus && item.isEx) {
									gyms[guid].isEx = true;
								}
								// don't overwrite existing medals
								if (importGymMedal && !gyms[guid].medal) {
									gyms[guid].medal = item.medal;
								}
							}
						}
					}
				});

				thisPlugin.updateStarPortal();
				thisPlugin.resetAllMarkers();
				thisPlugin.optAlert('Successful.');
			} catch (e) {
				console.warn('pogo: failed to import data: ' + e); // eslint-disable-line no-console
				thisPlugin.optAlert('<span style="color: #f88">Import failed</span>');
			}
		});
	};

	thisPlugin.optReset = function () {
		if (confirm('All pogo will be deleted. Are you sure?', '')) {
			delete localStorage[KEY_STORAGE];
			thisPlugin.createEmptyStorage();
			thisPlugin.updateStarPortal();
			thisPlugin.resetAllMarkers();
			if (settings.highlightGymCandidateCells) {
				updateMapGrid();
			}
			thisPlugin.optAlert('Successful.');
		}
	};

	/* POKEMON GO PORTALS LAYER */
	thisPlugin.addAllMarkers = function () {
		function iterateStore(store, type) {
			for (let idpogo in store) {
				const item = store[idpogo];
				const lat = item.lat;
				const lng = item.lng;
				const guid = item.guid;
				const name = item.name;
				thisPlugin.addStar(guid, lat, lng, name, type);
			}
		}

		iterateStore(gyms, 'gyms');
		iterateStore(pokestops, 'pokestops');
	};

	thisPlugin.resetAllMarkers = function () {
		for (let guid in stopLayers) {
			const starInLayer = stopLayers[guid];
			stopLayerGroup.removeLayer(starInLayer);
			delete stopLayers[guid];
		}
		for (let gymGuid in gymLayers) {
			const gymInLayer = gymLayers[gymGuid];
			gymLayerGroup.removeLayer(gymInLayer);
			delete gymLayers[gymGuid];
		}
		thisPlugin.addAllMarkers();
	};

	thisPlugin.addStar = function (guid, lat, lng, name, type) {
		let star;
		if (type === 'pokestops') {
			star = new L.Marker.SVGMarker([lat, lng], {
				title: name,
				iconOptions: {
					className: 'pokestop',
					html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 821.52 1461.152">
						<path class="pokestop-circle" d="M410.76 0C203.04.14 30.93 152.53 0 351.61l211.27.39c26.99-84.43 106.09-145.55 199.49-145.6 93.25.11 172.24 61.13 199.33 145.41l211.2.19C790.58 152.8 618.51.26 410.76 0zm0 280c-75.11 0-136 60.89-136 136s60.89 136 136 136 136-60.89 136-136-60.89-136-136-136zM.23 480c30.71 199.2 202.78 351.74 410.53 352 207.72-.14 379.83-152.53 410.76-351.61L610.25 480c-26.99 84.43-106.09 145.55-199.49 145.6-93.25-.11-172.24-61.13-199.33-145.41z"/>
						<path class="pokestop-pole" d="M380.387 818.725h65.085v465.159h-65.085z" stroke-width="4.402"/>
						<ellipse class="pokestop-base" cx="415.185" cy="1345.949" rx="305.686" ry="115.202" stroke-width="6"/>
						</svg>`,
					iconSize: L.point(24, 32),
					iconAnchor: [12, 38]
				}
			});

		}
		if (type === 'gyms') {
			// icon from https://github.com/FortAwesome/Font-Awesome/issues/9685#issuecomment-239238656
			const gym = gyms[guid];
			const medal = gym.medal || 'None';
			const className = medal + 'Medal' + (gym.isEx ? ' exGym' : '');
			star = new L.Marker.SVGMarker([lat, lng], {
				title: name,
				iconOptions: {
					id: 'gym' + guid.replace('.', ''),
					className: className,
					html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 410"><g transform="translate(-62 -45)">
			<path class="gym-main-outline" d="M436.23 45.87C368.38 181.94 300.54 318.02 232.7 454.09c-12.48-46.6-24.97-93.19-37.45-139.78l-1.67-6.2s-7.37-.21-12.03-.72c-57.77-3.97-109.7-50.53-117.27-107.86-11.31-57.8 25.24-118.19 79.1-139.79 57.74-24.6 130.02 2.07 160 56.72 39.96-20.87 80.14-42.63 120.19-63.84z" />
			<g class='gym-inner'><path class="ball-outline-top" d="M286.17 115.42l-59.41 31.59a48.157 48.157 0 0 0-35.7-15.96c-26.61 0-48.17 21.57-48.17 48.17.02 3.91.51 7.81 1.47 11.6l-59.45 31.62c-5.61-13.72-8.51-28.4-8.53-43.22 0-63.34 51.34-114.68 114.68-114.68 38.2.06 73.86 19.13 95.11 50.88z"/>
			<path d="M404.7 78.26L297.06 135.6l-59.42 31.6a48.252 48.252 0 0 1 1.58 12.02c0 26.6-21.56 48.16-48.16 48.16a48.138 48.138 0 0 1-36-16.27l-59.35 31.56c21.21 31.94 57 51.17 95.35 51.23 4.26-.02 8.52-.28 12.76-.77l32.78 122.31z" class="ball-outline-bottom"/>
			<path class="ball-outline-center" d="M191.06 144.82c19 0 34.4 15.4 34.4 34.4s-15.4 34.4-34.4 34.4c-19.01 0-34.41-15.4-34.41-34.4s15.4-34.4 34.41-34.4z"/>
			</g></g></svg>`,
					iconSize: L.point(36, 36)
				}
			});
		}

		if (!star)
			return;

		window.registerMarkerForOMS(star);
		star.on('spiderfiedclick', function () {
			// don't try to render fake portals
			if (guid.indexOf('.') > -1) {
				renderPortalDetails(guid);
			}
		});

		if (type === 'pokestops') {
			stopLayers[guid] = star;
			star.addTo(stopLayerGroup);
		}
		if (type === 'gyms') {
			gymLayers[guid] = star;
			star.addTo(gymLayerGroup);
		}
	};

	thisPlugin.setupCSS = function () {
		$('<style>').prop('type', 'text/css').html(`
#sidebar #portaldetails h3.title{
	width:auto;
}
.pogoStop span,
.pogoGym span {
	display:inline-block;
	float:left;
	margin:3px 1px 0 4px;
	width:16px;
	height:15px;
	overflow:hidden;
	background-repeat:no-repeat;
}
.pogoStop span, .pogoStop.favorite:focus span,
.pogoGym span, .pogoGym.favorite:focus span {
	background-position:left top;
}
.pogoStop:focus span, .pogoStop.favorite span,
.pogoGym:focus span, .pogoGym.favorite span {
	background-position:right top;
}

/**********************************************
	DIALOG BOX
**********************************************/

/*---- Options panel -----*/
#pogoSetbox a{
	display:block;
	color:#ffce00;
	border:1px solid #ffce00;
	padding:3px 0;
	margin:10px auto;
	width:80%;
	text-align:center;
	background:rgba(8,48,78,.9);
}
#pogoSetbox a.disabled,
#pogoSetbox a.disabled:hover{
	color:#666;
	border-color:#666;
	text-decoration:none;
}

#pogoSetbox{
	text-align:center;
}
.pogoStop span {
	background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAPCAMAAACyXj0lAAACZFBMVEUAAAD///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAQECAAAAAAAGAQEAAAAPDw8AAAAMAgIAAAALAQEBAQETAwMAAAAGBQUMAgISEhIAAAAWFhYBAQEWAwMAAAACAgIDAwMFBQUGBgYJCQkPDw8REREVGBgWFhYXFxchISEiIiIkICAoKCgpICAtLCwtLi4uBQUuKysuLy8vEBAvMjEyMDAzMzM0NDQ4ODg5OTk6Ojo+Pj5AQUFBS0tCSEhDQ0NISEhJSUlMTExSUlJUVFRWVlZXV1dYCwtZCwtaWlpcXFxeXl5gYGBhBgZiYmJjY2NlDAxmDAxnZ2doaGhra2tsbGxtbW1wcHBwfHtxcXFycnJ0dHR1dXV2dnZ4CQl5eXl9fX2CgoKEhISFhYWGhoaIiIiIiomJh4qKioqLi4uMjIyNjY2PiZCQkJCUlJSXBASaERGanJycBAScnJytFRWuDg6urq6wFBS2wcG3t7e4FRW5t7q6Cwu6urq7Dg6+vr7CwsLDwMTEDg7FxcXHxsfIyMjJFxfKDw/MDg7MzMzPz8/P0NDQ0NDRDw/RFxfS09XX19faGBja2trbExPc3NzlGhrl5eXo6Ojs7u7u7u7vGxvwGhrw8PDyGhry8vLz8/P0Ghr3Gxv39/f4+Pj8/Pz8/v79/f3+////HBz/HR3/Hh7///9j6e8DAAAAPnRSTlMAAAIKDBIWGBshJTI0O0tQY2VocnN1fImVnZ6lqKmrrLCxs7u8vb3G0tbW1tra39/i4uXl7Ozv7+/v8fH6+jTKPt8AAAGeSURBVHgBYwACZiFlAxMdWT4Qm5ERImBoqgsUgAAeDfe8hsbaZEd5VpACkED6rK27Nk4IAAoAAbdZVldXd3dXV5OXOgtIAbfFlFMnT5w4eXJ3IVCAgVkzGywNJJo9JIAKmLWnnwJJA9XszZBgYBD0AEp1F2fWd3W3VtpwMTIKZgDlT8yZtPnUiYPrbLkYVEuBuj3t7OxyurpbPEUYGdWWnTp5MjeuwnfqqRMHCkQYjIoqK9Psqu2jHapqyiKlGRmN5y1f3h+7vn1G8Iq1i+qkGczsgMDewS7JDgSUGBnN/fyD3Np67BaG+IUGeisx6M0/fbrELjXK0e7QsfkukoyM+jtOn17ts2R2d8zR4zsmSjIoRJ8+fdoVqLn59LYFdgKMjApzgQKTw+KjN50+vDNPgIHf7jQQLO0EEqvyzdgYGfkTQAJ7tgCJfSst2RiYVJxPQ8E0O2FgODCp9MEEticKA0OSQ9NhP5jbYCcFDmoOrY4jYIENSVLguGCXs3NKKY2wsxIDRxZIILx38ZqZ5dZAAQjgFVdUlhHlhMQmmgAAN4GpuWb98MUAAAAASUVORK5CYII=);
}
.pogoGym span {
	background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAPCAMAAACyXj0lAAAC7lBMVEUAAAD///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQEAAAAAAAAAAAAAAAAAAAABAQEAAAABAQEBAQEAAAAAAAAAAAAAAAAAAAADAwMAAAAAAAABAQIAAAAAAAAAAAAAAAAAAAACAgIAAAAAAAABAAAAAAAAAAAAAAAAAAACAgIAAAAHBwcAAAACAgIAAAAbBgYBAQEBAQEZBgcAAAAAAAAAAAABAQEXFxcCAgICAgIHBAUBAQEGBgdyFRcRERFsFRYCAgIDAwMFBQUODg4EBAQFBQUREREFBQUGBgYTExMRCQoEBAQGBAVcIiYaGhoaGhsFBQUUFBRaJSgGBgYdFBgDAwMEBAQNDQ0ODg4fHyAjIyNYWFheLTEHBgcHBwgJCQkLCwsNDQ0PDw8RERESEhIUFBQVFRYWFhYXFxcYGBgZGRkZGRoaGhocHBwdHR0eHh4eHx8fHx8iIiIlJSUmJiYnJycpKSkqKiotLS0uLi4uLi8wMDAyMjIzMzM0NDQ2NjY4ODg6Ojo7Ozs7Oz09PT4+Pj4/Pz9DKS9DQ0NJSUpLS0xMTE1NTU1PT09QUFBRUVFSUlNXV1dZWVlbW1tcXFxeXl5eXl9jY2NkZGRmZmZoaGlsbG1wcHBycnJ1dXV7e3t/f3+AgYGBgYGFhYWIh4mPj4+THyGTk5SVlZWYmJqbm5ygoKCnp6irq6uvr6+wr7KwsLGxsbO1tbW3tri4t7m5ubu9HyDGxcjGxsfJJyjOzs7PHR7QIyTQ0NDR0dHSICHS0tLU1NTY2NjZ2dndIiPd3d3e3t7fIyTi4uLj4+PnICHn5+jq6urs6+zs7Ozu7u7w8PDw8PHx8fHx8fLy8fLy8vLzHR329vb29vf39/j4+Pj5+fn6Hh76Hx/7+/v7+/z8Hx/8/Pz8/P39Hh79/f3///+f+BszAAAAcXRSTlMAAAECAwQFBwoPFhskJSYqKy4yMzU4OTw/Q0hRW1xjZGVmb294e3+Fi4+QkZibnaWmqq+2t7m+x8nKzM3Oz9HR19fd3d/h4eLk5ebm5+rq7O7v8PDy8vP09fX19/f3+Pn5+fr6/Pz8/f3+/v7+/v7+/k5HHiYAAAGUSURBVHgBY2BkFHMMizAVYmRk5NLSVAJSUg5uwYHOlmIMjFzq+soMbHrZ3WsWNyfJ8Gh7pOTxMjJKW6fd/v79S6IFn4FXciUvg3HNoqXNk5Y3ZcXXLSrVBRooW3Dvw/lTr75nZM7Yvd6dgcF37YqGxTOrayZsubkgkpOBkd3v7MddLX2zL7cef3srSoWBIWh1z6yL2zo2XH9wpRLIZeSKu3Bj4uGj03tOv/+60IaBgSG0cWrnypldO5+8nubPDLSBI6GwpGje5KoDn3/uCxAEKvBctH9Oe+/GOy83lykyABUw+aw7sbV/yt4XPx83aTEAgXzxwSeX7t78ca3DDiTPyKBQsePd/YfPP71f5crGAAJGOduP3X3/aHW6AEQBg1ru3DM/fn47kioHFACpMHSy3/PsULc5SB6sQtI2Ov/pm2UeDEAREGLRsPK+uilaAqoApEku/NzJWHGQAASLurd1m4CYcBUuS+abQW0E8xXLQ4RBTLgS1foYfpgCEClSqwFiIYBIqzZEACrMrceKqoBbhxmqAAABho1+nW2udAAAAABJRU5ErkJggg==);
}

.PogoButtons {
	color: #fff;
	padding: 3px;
	font-size : 18px;
}

.PogoButtons span {
	float: none;
}

.notPogo span {
    color: #FFF;
    background: #000;
    border-radius: 50%;
    font-size: 10px;
    letter-spacing: -0.15em;
    display: inline-block;
    padding: 2px;
    opacity: 0.6;
    margin: 3px 1px 0 2px;
    height: 15px;
    width: 16px;
    box-sizing: border-box;
    line-height: 1;
}

.notPogo span:after {
    display: inline-block;
    content: "N/A";
    position: absolute;
}

.notPogo:focus span, .notPogo.favorite span {
	opacity: 1;
}

.pogo-text {
	text-align: center;
	font-weight: bold;
	border: none !important;
	background: none !important;
	font-size: 130%;
	color: #000;
	text-shadow: 1px 1px #FFF, 2px 2px 6px #fff, -1px -1px #fff, -2px -2px 6px #fff;
}

#PogoGymInfo {
	display: none;
    padding: 3px;
}

.isGym #PogoGymInfo {
	display: block;
}

.thisIsPogo .layer_off_warning,
.thisIsPogo .mods,
.thisIsPogo #randdetails,
.thisIsPogo #resodetails,
.thisIsPogo #level {
    display: none;
}

.thisIsPogo #playerstat,
.thisIsPogo #gamestat,
.thisIsPogo #redeem,
.thisIsPogo #chat,
.thisIsPogo #artifactLink,
.thisIsPogo #scoresLink,
.thisIsPogo #chatinput,
.thisIsPogo #chatcontrols {
    display: none;
}

.thisIsPogo #mobileinfo .portallevel,
.thisIsPogo #mobileinfo .resonator {
    display: none;
}

.thisIsPogo #sidebar #portaldetails h3.title {
	color: #fff;
}

.gym-main-outline {
	fill: #FFF;
	stroke: #000;
	stroke-width: 5;
}

.gym-inner path {
	fill: #fff;
	stroke: #000;
	stroke-width: 2;
}

.GoldMedal .gym-main-outline,
.GoldMedal .ball-outline-center {
	fill: #FEED55;
}
.SilverMedal .gym-main-outline,
.SilverMedal .ball-outline-center {
	fill: #CEDFE6;
}
.BronzeMedal .gym-main-outline,
.BronzeMedal .ball-outline-center {
	fill: #F0B688;
}

.GoldMedal .gym-inner path {
	stroke: #EDC13C;
	stroke-width: 20;
}
.SilverMedal .gym-inner path {
	stroke: #A4C1C7;
	stroke-width: 20;
}
.BronzeMedal .gym-inner path {
	stroke: #DD9D71;
	stroke-width: 10;
}

.gym-inner .ball-outline-top {
	fill: #f71208;
}

.exGym {
	position: relative;
}

.exGym:after {
    content: "EX";
    font-weight: bold;
    text-shadow: 1px 1px 3px #BED1D5, -1px -1px 3px #BED1D5;
    color: #09131D;
    font-size: 130%;
    position: absolute;
    top: 0;
    right: 0;
}

.pokestop {
    opacity: 0.75;
}

.pokestop path,
.pokestop ellipse {
    fill: #2370DA;
}

path.pokestop-circle {
    fill: #23FEF8;
    stroke-width: 30px;
    stroke: #2370DA;
}

.smallpokestops .pokestop {
    opacity: 0.85;
}

.smallpokestops path.pokestop-pole,
.smallpokestops ellipse.pokestop-base {
	display: none;
}

.smallpokestops .pokestop svg {
	transform: translateY(25px) scale(0.8);
}

.PogoClassification div {
    display: grid;
    grid-template-columns: 200px 60px 60px 60px;
    text-align: center;
    align-items: center;
    height: 140px;
    overflow: hidden;
	margin-bottom: 10px;
}

.PogoClassification div:nth-child(odd) {
	background: rgba(7, 42, 69, 0.9);
}

.PogoClassification img {
    max-width: 200px;
	max-height: 140px;
    display: block;
    margin: 0 auto;
}

#dialog-missingPortals .PogoClassification div {
	height: 50px;
}

img.photo,
.ingressLocation,
.pogoLocation {
    cursor: zoom-in;
}

.PoGo-PortalAnimation {
	width: 30px;
	height: 30px;
	background-color: rgba(255, 255, 255, 0.5);
	border-radius: 50%;
	box-shadow: 0px 0px 4px white;
	animation-duration: 1s;
	animation-name: shrink;
}

@keyframes shrink {
	from {
		width: 30px;
		height: 30px;
		top: 0px;
		left: 0px;
	}

	to {
		width: 10px;
		height: 10px;
		top: 10px;
		left: 10px;
	}
}

.PoGo-PortalAnimationHover {
	background-color: rgb(255, 102, 0, 0.8);
	border-radius: 50%;
	animation-duration: 1s;
	animation-name: shrinkHover;
	animation-iteration-count: infinite;
}

@keyframes shrinkHover {
	from {
		width: 40px;
		height: 40px;
		top: 0px;
		left: 0px;
	}

	to {
		width: 20px;
		height: 20px;
		top: 10px;
		left: 10px;
	}
}

#sidebarPogo {
    color: #eee;
    padding: 2px 5px;
    font-size : 18px;
}

#sidebarPogo span {
    margin-right: 5px;
}

#toolbox {
    font-size : 18px;
}

.refreshingData,
.refreshingPortalCount {
    opacity: 0.5;
	pointer-events: none;
}

#sidebarPogo.mobile {
    width: 100%;
    background: rebeccapurple;
    display: flex;
}

#sidebarPogo.mobile > div {
    margin-right: 1em;
}

.pogo-colors input[type=color] {
	border: 0;
	padding: 0;
}

`).appendTo('head');
	};

	// A portal has been received.
	function onPortalAdded(data) {
		const guid = data.portal.options.guid;

		data.portal.on('add', function () {
			addNearbyCircle(guid);
			window.clearTimeout(relayoutTimer);
			relayoutTimer = window.setTimeout(relayerBackgroundGroups, 100);
		});

		data.portal.on('remove', function () {
			removeNearbyCircle(guid);
		});

		// analyze each portal only once, but sometimes the first time there's no additional data of the portal
		if (allPortals[guid] && allPortals[guid].name)
			return;

		const portal = {
			guid: guid,
			name: data.portal.options.data.title,
			lat: data.portal._latlng.lat,
			lng: data.portal._latlng.lng,
			image: data.portal.options.data.image,
			cells: {}
		};

		allPortals[guid] = portal;

		// If it's already classified in Pokemon, get out
		const pogoData = thisPlugin.findByGuid(guid);
		if (pogoData) {
			const pogoItem = pogoData.store[guid];
			if (!pogoItem.exists) {
				// Mark that it still exists in Ingress
				pogoItem.exists = true;

				if (missingPortals[guid]) {
					delete missingPortals[guid];
					updateMissingPortalsCount();
				}

				// Check if it has been moved
				if (pogoItem.lat != portal.lat || pogoItem.lng != portal.lng) {
					movedPortals.push({
						pogo: pogoItem,
						ingress: portal
					});
					updateCounter('moved', movedPortals);
				}
			}
			if (portal.name && pogoItem.name !== portal.name) {
				pogoData.store[guid].name = portal.name;
			}
			return;
		}

		if (skippedPortals[guid] || newPokestops[guid])
			return;

		newPortals[guid] = portal;

		refreshNewPortalsCounter();
	}

	/**
	 * Draw a 20m circle around a portal
	 */
	function addNearbyCircle(guid) {
		const portal = window.portals[guid];
		if (!portal)
			return;

		const circleSettings = {
			color: settings.colors.nearbyCircleBorder.color,
			opacity: settings.colors.nearbyCircleBorder.opacity,
			fillColor: settings.colors.nearbyCircleFill.color,
			fillOpacity: settings.colors.nearbyCircleFill.opacity,
			weight: 1,
			clickable: false,
			interactive: false
		};

		const center = portal._latlng;
		const circle = L.circle(center, 20, circleSettings);
		nearbyLayerGroup.addLayer(circle);
		nearbyCircles[guid] = circle;
	}

	/**
	 * Removes the 20m circle if a portal is purged
	 */
	function removeNearbyCircle(guid) {
		const circle = nearbyCircles[guid];
		if (circle != null) {
			nearbyLayerGroup.removeLayer(circle);
			delete nearbyCircles[guid];
		}
	}

	function redrawNearbyCircles() {
		const keys = Object.keys(nearbyCircles);
		keys.forEach(guid => {
			removeNearbyCircle(guid);
			addNearbyCircle(guid);
		});
		relayerBackgroundGroups();
	}

	/**
	 * Re-orders the layerGroups within regionLayer so that foreground objects don't get hidden/obscured by background layers.
	 */
	function relayerBackgroundGroups() {
		if (!map.hasLayer(regionLayer)) {
			return;
		}
		if (regionLayer.hasLayer(nearbyLayerGroup)) {
			nearbyLayerGroup.bringToBack();
		}
		if (regionLayer.hasLayer(cellLayerGroup)) {
			cellLayerGroup.bringToBack();
		}
		if (regionLayer.hasLayer(gymCenterLayerGroup)) {
			gymCenterLayerGroup.bringToFront();
		}
	}

	function refreshNewPortalsCounter() {
		if (!settings.analyzeForMissingData)
			return;

		// workaround for https://bugs.chromium.org/p/chromium/issues/detail?id=961199
		try
		{
			if (checkNewPortalsTimer) {
				clearTimeout(checkNewPortalsTimer);
			} else {
				document.getElementById('sidebarPogo').classList.add('refreshingPortalCount');
			}
		} catch (e) {
			// nothing
		}

		// workaround for https://bugs.chromium.org/p/chromium/issues/detail?id=961199
		try
		{
			checkNewPortalsTimer = setTimeout(checkNewPortals, 1000);
		} catch (e) {
			checkNewPortals();
		}
	}

	/**
	 * A potential new portal has been received
	 */
	function checkNewPortals() {
		checkNewPortalsTimer = null;

		// don't try to classify if we don't have all the portal data
		if (map.getZoom() < 15)
			return;

		document.getElementById('sidebarPogo').classList.remove('refreshingPortalCount');

		newPokestops = {};
		notClassifiedPokestops = [];

		const allCells = groupByCell(poiCellLevel);

		// Check only the items inside the screen,
		// the server might provide info about remote portals if they are part of a link
		// and we don't know anything else about nearby portals of that one.
		// In this case (vs drawing) we want to filter only cells fully within the screen
		const cells = filterWithinScreen(allCells);

		// try to guess new pokestops if they are the only items in a cell
		Object.keys(cells).forEach(id => {
			const data = allCells[id];
			checkIsPortalMissing(data.gyms, data);
			checkIsPortalMissing(data.stops, data);
			//checkIsPortalMissing(data.notpogo);

			if (data.notClassified.length == 0)
				return;
			const notClassified = data.notClassified;

			if (data.gyms.length > 0 || data.stops.length > 0) {
				// Already has a pogo item, ignore the rest
				notClassified.forEach(portal => {
					skippedPortals[portal.guid] = true;
					delete newPortals[portal.guid];
				});
				return;
			}
			// only one, let's guess it's a pokestop by default
			if (notClassified.length == 1) {
				const portal = notClassified[0];
				const obj = {'guid': portal.guid, 'lat': portal.lat, 'lng': portal.lng, 'name': portal.name};

				newPokestops[portal.guid] = obj;
				//delete newPortals[portal.guid];
				return;
			}

			// too many items to guess
			notClassifiedPokestops.push(data.notClassified);
		});

		updateCounter('pokestops', Object.values(newPokestops));
		updateCounter('classification', notClassifiedPokestops);
		updateMissingPortalsCount();

		// Now gyms
		checkNewGyms();
	}

	/**
	 * Filter the missing portals detection to show only those on screen and reduce false positives
	 */
	function updateMissingPortalsCount() {
		const keys = Object.keys(missingPortals);
		if (keys.length == 0)
			updateCounter('missing', []);

		const bounds = map.getBounds();
		const filtered = [];
		keys.forEach(guid => {
			const pogoData = thisPlugin.findByGuid(guid);
			const item = pogoData.store[guid];
			if (isPointOnScreen(bounds, item)) {
				filtered.push(item);
			}
		});
		updateCounter('missing', filtered);
	}

	/**
	 * Given an array of pogo items checks if they have been removed from Ingress
	 */
	function checkIsPortalMissing(array, cellData) {
		array.forEach(item => {
			if (item.exists || item.newGuid)
				return;
			const guid = item.guid;

			if (findCorrectGuid(item, cellData.notClassified)) {
				return;
			}
			if (!missingPortals[guid]) {
				missingPortals[guid] = true;
			}
		});
	}

	/**
	 * Check if there's another real portal in the same cell (we're checking a pogo that doesn't exist in Ingress)
	 */
	function findCorrectGuid(pogoItem, array) {
		const portal = array.find(x => x.name == pogoItem.name && x.guid != pogoItem.guid);
		if (portal != null) {
			pogoItem.newGuid = portal.guid;
			movedPortals.push({
				pogo: pogoItem,
				ingress: portal
			});
			updateCounter('moved', movedPortals);

			delete missingPortals[pogoItem.guid];

			return true;
		}
		return false;
	}

	function checkNewGyms() {
		const cellsWithMissingGyms = [];

		const allCells = groupByCell(gymCellLevel);

		// Check only the items inside the screen,
		// the server might provide info about remote portals if they are part of a link
		// and we don't know anything else about nearby portals of that one.
		// In this case (vs drawing) we want to filter only cells fully within the screen
		const cells = filterWithinScreen(allCells);

		// Find the cells where new Gyms can be identified
		Object.keys(cells).forEach(id => {
			const data = allCells[id];
			// Only cells with all the portals already analyzed
			if (data.notClassified.length > 0)
				return;
			if (ignoredCellsMissingGyms[data.cell.toString()])
				return;
			const missingGyms = computeMissingGyms(data);
			if (missingGyms > 0) {
				cellsWithMissingGyms.push(data);
			}
		});

		if (cellsWithMissingGyms.length > 0) {
			const filtered = filterWithinScreen(cellsWithMissingGyms);
			updateCounter('gyms', Object.values(filtered));
		} else {
			updateCounter('gyms', []);
		}
	}

	/**
	 * Display new pokestops so they can be added
	 */
	function promptForNewPokestops(data) {
		if (data.length == 0)
			return;
		let pending = data.length;

		const div = document.createElement('div');
		div.className = 'PogoClassification';
		data.sort(sortByName).forEach(portal => {
			const wrapper = document.createElement('div');
			wrapper.setAttribute('data-guid', portal.guid);
			const img = getPortalImage(portal);
			wrapper.innerHTML = '<span class="PogoName">' + getPortalName(portal) +
				img + '</span>' +
				'<a data-type="pokestops">' + 'STOP' + '</a>' +
				'<a data-type="gyms">' + 'GYM' + '</a>' +
				'<a data-type="notpogo">' + 'N/A' + '</a>';
			div.appendChild(wrapper);
		});
		const container = dialog({
			id: 'classifyPokestop',
			html: div,
			width: '420px',
			title: 'Are all of these Pokestops or Gyms?',
			buttons: {
				// Button to allow skip this cell
				'Skip': function () {
					container.dialog('close');
					data.forEach(portal => {
						delete newPokestops[portal.guid];
						skippedPortals[portal.guid] = true;
					});
					updateCounter('pokestops', Object.values(newPokestops));
				},
				'Mark all as Pokestops': function () {
					container.dialog('close');
					data.forEach(portal => {
						if (!newPokestops[portal.guid])
							return;

						delete newPokestops[portal.guid];
						thisPlugin.addPortalpogo(portal.guid, portal.lat, portal.lng, portal.name, 'pokestops');
					});
					if (settings.highlightGymCandidateCells) {
						updateMapGrid();
					}
					updateCounter('pokestops', Object.values(newPokestops));
				}
			}
		});
		// Remove ok button
		const outer = container.parent();
		outer.find('.ui-dialog-buttonset button:first').remove();

		// mark the selected one as pokestop or gym
		container.on('click', 'a', function (e) {
			const type = this.getAttribute('data-type');
			const row = this.parentNode;
			const guid = row.getAttribute('data-guid');
			const portal = allPortals[guid];
			delete newPokestops[portal.guid];
			thisPlugin.addPortalpogo(guid, portal.lat, portal.lng, portal.name, type);
			if (settings.highlightGymCandidateCells) {
				updateMapGrid();
			}
			$(row).fadeOut(200);
			pending--;
			if (pending == 0) {
				container.dialog('close');
			}
			updateCounter('pokestops', Object.values(newPokestops));
		});

		container.on('click', 'img.photo', centerPortal);
		configureHoverMarker(container);
	}

	/**
	 * In a level 17 cell there's more than one portal, ask which one is Pokestop or Gym
	 */
	function promptToClassifyPokestops() {
		updateCounter('classification', notClassifiedPokestops);
		if (notClassifiedPokestops.length == 0)
			return;

		const group = notClassifiedPokestops.shift();
		const div = document.createElement('div');
		div.className = 'PogoClassification';
		group.sort(sortByName).forEach(portal => {
			const wrapper = document.createElement('div');
			wrapper.setAttribute('data-guid', portal.guid);
			const img = getPortalImage(portal);
			wrapper.innerHTML = '<span class="PogoName">' + getPortalName(portal) +
				img + '</span>' +
				'<a data-type="pokestops">' + 'STOP' + '</a>' +
				'<a data-type="gyms">' + 'GYM' + '</a>';
			div.appendChild(wrapper);
		});
		const container = dialog({
			id: 'classifyPokestop',
			html: div,
			width: '360px',
			title: 'Which one is in Pokemon Go?',
			buttons: {
				// Button to allow skip this cell
				Skip: function () {
					container.dialog('close');
					group.forEach(portal => {
						delete newPortals[portal.guid];
						skippedPortals[portal.guid] = true;
					});
					// continue
					promptToClassifyPokestops();
				}
			}
		});
		// Remove ok button
		const outer = container.parent();
		outer.find('.ui-dialog-buttonset button:first').remove();

		// mark the selected one as pokestop or gym
		container.on('click', 'a', function (e) {
			const type = this.getAttribute('data-type');
			const guid = this.parentNode.getAttribute('data-guid');
			const portal = getPortalSummaryFromGuid(guid);
			thisPlugin.addPortalpogo(guid, portal.lat, portal.lng, portal.name, type);
			if (settings.highlightGymCandidateCells) {
				updateMapGrid();
			}

			group.forEach(tmpPortal => {
				delete newPortals[tmpPortal.guid];
			});

			container.dialog('close');
			// continue
			promptToClassifyPokestops();
		});
		container.on('click', 'img.photo', centerPortal);
		configureHoverMarker(container);
	}

	/**
	 * List of portals that have been moved
	 */
	function promptToMovePokestops() {
		if (movedPortals.length == 0)
			return;

		const div = document.createElement('div');
		div.className = 'PogoClassification';
		movedPortals.sort(sortByName).forEach(pair => {
			const portal = pair.ingress;
			const pogoItem = pair.pogo;
			const wrapper = document.createElement('div');
			wrapper.setAttribute('data-guid', portal.guid);
			wrapper.dataPortal = portal;
			wrapper.dataPogoGuid = pogoItem.guid;
			const img = getPortalImage(portal);
			wrapper.innerHTML = '<span class="PogoName">' + getPortalName(portal) +
				img + '</span>' +
				'<span><span class="ingressLocation">' + 'Ingress location' + '</span></span>' +
				'<span><span class="pogoLocation" data-lat="' + pogoItem.lat + '" data-lng="' + pogoItem.lng + '">' + 'Pogo location' + '</span><br>' +
				'<a>' + 'Update' + '</a></span>';
			div.appendChild(wrapper);
		});
		const container = dialog({
			id: 'movedPortals',
			html: div,
			width: '360px',
			title: 'These portals have been moved in Ingress',
			buttons: {
				// Button to move all the portals at once
				'Update all': function () {
					container.dialog('close');
					movedPortals.forEach(pair => {
						const portal = pair.ingress;
						const pogoItem = pair.pogo;
						movePogo(portal, pogoItem.guid);
					});
					movedPortals.length = 0;
					updateCounter('moved', movedPortals);

					saveStorage();
					if (settings.highlightGymCandidateCells) {
						updateMapGrid();
					}

				}
			}
		});

		// Update location
		container.on('click', 'a', function (e) {
			const row = this.parentNode.parentNode;
			const portal = row.dataPortal;
			movePogo(portal, row.dataPogoGuid);

			saveStorage();
			if (settings.highlightGymCandidateCells) {
				updateMapGrid();
			}

			$(row).fadeOut(200);

			// remove it from the list of portals
			const idx = movedPortals.findIndex(pair => pair.ingress.guid == pair.ingress.guid);
			movedPortals.splice(idx, 1);
			updateCounter('moved', movedPortals);

			if (movedPortals.length == 0)
				container.dialog('close');
		});
		container.on('click', 'img.photo', centerPortal);
		container.on('click', '.ingressLocation', centerPortal);
		container.on('click', '.pogoLocation', centerPortalAlt);
		configureHoverMarker(container);
		configureHoverMarkerAlt(container);
	}

	/**
	 * Update location of a pogo item
	 */
	function movePogo(portal, pogoGuid) {
		const guid = portal.guid;
		const pogoData = thisPlugin.findByGuid(pogoGuid);

		const existingType = pogoData.type;
		let gym = null;
		if (existingType == 'gyms') {
			gym = pogoData.store[guid];
		}

		// remove marker
		removePogoObject(existingType, guid);

		// Draw new marker
		thisPlugin.addPortalpogo(guid, portal.lat, portal.lng, portal.name || pogoData.name, existingType);

		// copy gym status
		if (gym != null) {
			pogoData.store[guid].isEx = gym.isEx;
			pogoData.store[guid].medal = gym.medal;

			saveStorage();

			const icon = document.getElementById('gym' + guid.replace('.', ''));
			// update gym marker
			if (icon) {
				icon.classList.add(gym.medal + 'Medal');
				icon.classList[gym.isEx ? 'add' : 'remove']('exGym');
			}

		}
	}

	/**
	 * Pogo items that aren't in Ingress
	 */
	function promptToRemovePokestops(missing) {
		const div = document.createElement('div');
		div.className = 'PogoClassification';
		missing.sort(sortByName).forEach(portal => {
			const wrapper = document.createElement('div');
			wrapper.setAttribute('data-guid', portal.guid);
			const name = portal.name || 'Unknown';
			wrapper.innerHTML = '<span class="PogoName"><span class="pogoLocation" data-lat="' + portal.lat + '" data-lng="' + portal.lng + '">' + name + '</span></span>' +
				'<span><a>' + 'Remove' + '</a></span>';
			div.appendChild(wrapper);
		});
		const container = dialog({
			id: 'missingPortals',
			html: div,
			width: '360px',
			title: 'These portals are missing in Ingress',
			buttons: {
			}
		});

		// Update location
		container.on('click', 'a', function (e) {
			const row = this.parentNode.parentNode;
			const guid = row.getAttribute('data-guid');
			const pogoData = thisPlugin.findByGuid(guid);
			const existingType = pogoData.type;

			// remove marker
			removePogoObject(existingType, guid);
			saveStorage();

			if (settings.highlightGymCandidateCells) {
				updateMapGrid();
			}

			$(row).fadeOut(200);

			delete missingPortals[guid];
			updateMissingPortalsCount();

			if (Object.keys(missingPortals).length == 0) {
				container.dialog('close');
			}
		});
		container.on('click', '.pogoLocation', centerPortalAlt);
		configureHoverMarkerAlt(container);
	}

	function configureHoverMarker(container) {
		let hoverMarker;
		container.find('img.photo, .ingressLocation').hover(
			function hIn() {
				const row = this.parentNode.parentNode;
				const guid = row.getAttribute('data-guid');
				const portal = row.dataPortal || window.portals[guid];
				if (!portal)
					return;
				const center = portal._latlng || new L.LatLng(portal.lat, portal.lng);
				hoverMarker = L.marker(center, {
					icon: L.divIcon({
						className: 'PoGo-PortalAnimationHover',
						iconSize: [40, 40],
						iconAnchor: [20, 20],
						html: ''
					}),
					interactive: false
				});
				map.addLayer(hoverMarker);
			}, function hOut() {
				if (hoverMarker)
					map.removeLayer(hoverMarker);
			});
	}

	function configureHoverMarkerAlt(container) {
		let hoverMarker;
		container.find('.pogoLocation').hover(
			function hIn() {
				const lat = this.getAttribute('data-lat');
				const lng = this.getAttribute('data-lng');
				const center = new L.LatLng(lat, lng);
				hoverMarker = L.marker(center, {
					icon: L.divIcon({
						className: 'PoGo-PortalAnimationHover',
						iconSize: [40, 40],
						iconAnchor: [20, 20],
						html: ''
					}),
					interactive: false
				});
				map.addLayer(hoverMarker);
			}, function hOut() {
				if (hoverMarker)
					map.removeLayer(hoverMarker);
			});
	}

	/**
	 * Center the map on the clicked portal to help tracking it (the user will have to manually move the dialog)
	 */
	function centerPortal(e) {
		const row = this.parentNode.parentNode;
		const guid = row.getAttribute('data-guid');
		const portal = row.dataPortal || window.portals[guid];
		if (!portal)
			return;
		const center = portal._latlng || new L.LatLng(portal.lat, portal.lng);
		map.panTo(center);
		drawClickAnimation(center);
	}

	function centerPortalAlt(e) {
		const lat = this.getAttribute('data-lat');
		const lng = this.getAttribute('data-lng');
		const center = new L.LatLng(lat, lng);
		map.panTo(center);
		drawClickAnimation(center);
	}

	function drawClickAnimation(center) {
		const marker = L.marker(center, {
			icon: L.divIcon({
				className: 'PoGo-PortalAnimation',
				iconSize: [30, 30],
				iconAnchor: [15, 15],
				html: ''
			}),
			interactive: false
		});
		map.addLayer(marker);

		setTimeout(function () {
			map.removeLayer(marker);
		}, 2000);
	}

	function getPortalSummaryFromGuid(guid) {
		const newPortal = newPortals[guid];
		if (newPortal)
			return newPortal;

		const portal = window.portals[guid];
		if (!portal)
			return {};

		return {
			guid: guid,
			name: portal.options.data.title,
			lat: portal._latlng.lat,
			lng: portal._latlng.lng,
			image: portal.options.data.image,
			cells: {}
		};
	}

	function getPortalImage(pokestop) {
		if (pokestop.image)
			return '<img src="' + pokestop.image.replace('http:', 'https:') + '" class="photo">';

		const portal = window.portals[pokestop.guid];
		if (!portal)
			return '';

		if (portal && portal.options && portal.options.data && portal.options.data.image) {
			pokestop.image = portal.options.data.image;
			return '<img src="' + pokestop.image.replace('http:', 'https:') + '" class="photo">';
		}
		return '';
	}

	function getPortalName(pokestop) {
		if (pokestop.name)
			return pokestop.name;

		const portal = window.portals[pokestop.guid];
		if (!portal)
			return '';

		if (portal && portal.options && portal.options.data && portal.options.data.title) {
			pokestop.name = portal.options.data.title;
			return pokestop.name;
		}
		return '';
	}

	/**
	 * In a level 14 cell there's some missing Gyms, prompt which ones
	 */
	function promptToClassifyGyms(groups) {
		// don't try to classify if we don't have all the portal data
		if (map.getZoom() < 15)
			return;

		if (!groups || groups.length == 0)
			return;

		const cellData = groups.shift();
		updateCounter('gyms', groups);

		let missingGyms = computeMissingGyms(cellData);

		const div = document.createElement('div');
		div.className = 'PogoClassification';
		cellData.stops.sort(sortByName).forEach(portal => {
			if (skippedPortals[portal.guid])
				return;

			const wrapper = document.createElement('div');
			wrapper.setAttribute('data-guid', portal.guid);
			wrapper.innerHTML =
				'<span class="PogoName">' + getPortalName(portal) +
				getPortalImage(portal) + '</span>' +
				'<a data-type="gyms">' + 'GYM' + '</a>';
			div.appendChild(wrapper);
		});
		// No pokestops to prompt as it has been skipped
		if (!div.firstChild) {
			// continue
			promptToClassifyGyms(groups);
			return;
		}

		const container = dialog({
			id: 'classifyPokestop',
			html: div,
			width: '360px',
			title: missingGyms == 1 ? 'Which one is a Gym?' : 'Which ' + missingGyms + ' are Gyms?',
			buttons: {
				// Button to allow skip this cell
				Skip: function () {
					container.dialog('close');
					cellData.stops.forEach(portal => {
						skippedPortals[portal.guid] = true;
					});
					// continue
					promptToClassifyGyms(groups);
				},
				// Button to allow skip this cell
				'There is no Gym': function () {
					ignoredCellsMissingGyms[cellData.cell.toString()] = true;

					if (settings.highlightGymCandidateCells) {
						updateMapGrid();
					}
					container.dialog('close');

					saveStorage();

					updateCounter('gyms', groups);
					// continue
					promptToClassifyGyms(groups);
				}
			}
		});
		// Remove ok button
		const outer = container.parent();
		outer.find('.ui-dialog-buttonset button:first').remove();

		// mark the selected one as pokestop or gym
		container.on('click', 'a', function (e) {
			const type = this.getAttribute('data-type');
			const row = this.parentNode;
			const guid = row.getAttribute('data-guid');
			const portal = pokestops[guid];

			removePogoObject('pokestops', guid);

			thisPlugin.addPortalpogo(guid, portal.lat, portal.lng, portal.name, type);
			if (settings.highlightGymCandidateCells) {
				updateMapGrid();
			}
			missingGyms--;
			if (missingGyms == 0) {
				container.dialog('close');
				// continue
				promptToClassifyGyms(groups);
			} else {
				$(row).fadeOut(200);
				document.querySelector('.ui-dialog-title-active').textContent = missingGyms == 1 ? 'Which one is a Gym?' : 'Which ' + missingGyms + ' are Gyms?';
			}
		});

		container.on('click', 'img.photo', centerPortal);
		configureHoverMarker(container);
	}

	/**
	 * In a level 14 cell there are too many Gyms
	 */
	function promptToVerifyGyms(cellIds) {
		if (!cellIds)
			cellIds = Object.keys(cellsExtraGyms);

		if (cellIds.length == 0)
			return;

		const cellId = cellIds[0];
		const group = findCellItems(cellId, gymCellLevel, gyms);

		const div = document.createElement('div');
		div.className = 'PogoClassification';
		group.sort(sortByName).forEach(portal => {
			const wrapper = document.createElement('div');
			wrapper.setAttribute('data-guid', portal.guid);
			const img = getPortalImage(portal);
			wrapper.innerHTML = '<span class="PogoName">' + getPortalName(portal) +
				img + '</span>' +
				'<a data-type="pokestops">' + 'STOP' + '</a>';
			div.appendChild(wrapper);
		});
		const container = dialog({
			id: 'classifyPokestop',
			html: div,
			width: '360px',
			title: 'This cell has too many Gyms.',
			buttons: {
				// Button to allow skip this cell
				'All are OK': function () {
					ignoredCellsExtraGyms[cellId] = true;

					if (settings.highlightGymCandidateCells) {
						updateMapGrid();
					}
					container.dialog('close');
					delete cellsExtraGyms[cellId];

					saveStorage();

					updateCounter('extraGyms', Object.keys(cellsExtraGyms));
					// continue
					promptToVerifyGyms();
				}
			}
		});
		// Remove ok button
		const outer = container.parent();
		outer.find('.ui-dialog-buttonset button:first').remove();

		// mark the selected one as pokestop or gym
		container.on('click', 'a', function (e) {
			const type = this.getAttribute('data-type');
			const guid = this.parentNode.getAttribute('data-guid');
			const portal = gyms[guid];
			thisPlugin.addPortalpogo(guid, portal.lat, portal.lng, portal.name, type);
			if (settings.highlightGymCandidateCells) {
				updateMapGrid();
			}

			container.dialog('close');
			delete cellsExtraGyms[cellId];
			updateCounter('extraGyms', Object.keys(cellsExtraGyms));
			// continue
			promptToVerifyGyms();
		});
		container.on('click', 'img.photo', centerPortal);
		configureHoverMarker(container);
	}


	function removeLayer(name) {
		const layers = window.layerChooser._layers;
		const layersIds = Object.keys(layers);

		let layerId = null;
		let leafletLayer;
		let isBase;
		let arrayIdx;
		layersIds.forEach(id => {
			const layer = layers[id];
			if (layer.name == name) {
				leafletLayer = layer.layer;
				layerId = leafletLayer._leaflet_id;
				isBase = !layer.overlay;
				arrayIdx = id;
			}
		});

		// The Beacons and Frackers are not there in Firefox, why????
		if (!leafletLayer) {
			return;
		}

		const enabled = map._layers[layerId] != null;
		if (enabled) {
			// Don't remove base layer if it's used
			if (isBase)
				return;

			map.removeLayer(leafletLayer);
		}
		if (typeof leafletLayer.off != 'undefined')
			leafletLayer.off();

		// new Leaflet
		if (Array.isArray(layers)) {
			// remove from array
			layers.splice(parseInt(arrayIdx, 10), 1);
		} else {
			// classic IITC, leaflet 0.7.7
			// delete from object
			delete layers[layerId];
		}
		window.layerChooser._update();
		removedLayers[name] = {
			layer: leafletLayer,
			enabled: enabled,
			isBase: isBase
		};
		window.updateDisplayedLayerGroup(name, enabled);
	}
	const removedLayers = {};
	let portalsLayerGroup;

	function removeIngressLayers() {
		removeLayer('CartoDB Dark Matter');
		removeLayer('CartoDB Positron');
		removeLayer('Google Default Ingress Map');

		removeLayer('Fields');
		removeLayer('Links');
		removeLayer('DEBUG Data Tiles');
		removeLayer('Artifacts');
		removeLayer('Ornaments');
		removeLayer('Beacons');
		removeLayer('Frackers');

		removeLayer('Unclaimed/Placeholder Portals');
		for (let i = 1; i <= 8; i++) {
			removeLayer('Level ' + i + ' Portals');
		}
		//removeLayer('Resistance');
		//removeLayer('Enlightened');
		mergePortalLayers();
	}

	/**
	 * Put all the layers for Ingress portals under a single one
	 */
	function mergePortalLayers() {
		portalsLayerGroup = new L.LayerGroup();
		window.addLayerGroup('Ingress Portals', portalsLayerGroup, true);
		portalsLayerGroup.addLayer(removedLayers['Unclaimed/Placeholder Portals'].layer);
		for (let i = 1; i <= 8; i++) {
			portalsLayerGroup.addLayer(removedLayers['Level ' + i + ' Portals'].layer);
		}
		//portalsLayerGroup.addLayer(removedLayers['Resistance'].layer);
		//portalsLayerGroup.addLayer(removedLayers['Enlightened'].layer);
	}

	/**
	 * Remove the single layer for all the portals
	 */
	function revertPortalLayers() {
		if (!portalsLayerGroup) {
			return;
		}
		const name = 'Ingress Portals';
		const layerId = portalsLayerGroup._leaflet_id;
		const enabled = map._layers[layerId] != null;

		const layers = window.layerChooser._layers;
		if (Array.isArray(layers)) {
			// remove from array
			const idx = layers.findIndex(o => o.layer._leaflet_id == layerId);
			layers.splice(idx, 1);
		} else {
			// classic IITC, leaflet 0.7.7
			// delete from object
			delete layers[layerId];
		}
		window.layerChooser._update();
		window.updateDisplayedLayerGroup(name, enabled);

		if (typeof portalsLayerGroup.off != 'undefined')
			portalsLayerGroup.off();
		if (enabled) {
			map.removeLayer(portalsLayerGroup);
		}
		portalsLayerGroup = null;
	}

	function restoreIngressLayers() {
		revertPortalLayers();

		Object.keys(removedLayers).forEach(name => {
			const info = removedLayers[name];
			if (info.isBase)
				window.layerChooser.addBaseLayer(info.layer, name);
			else
				window.addLayerGroup(name, info.layer, info.enabled);
		});
	}

	function zoomListener() {
		const zoom = map.getZoom();
		document.body.classList.toggle('smallpokestops', zoom < 16);
	}

	const setup = function () {
		thisPlugin.isSmart = window.isSmartphone();

		initSvgIcon();

		loadSettings();

		// Load data from localStorage
		thisPlugin.loadStorage();

		thisPlugin.htmlStar = `<a class="pogoStop" accesskey="p" onclick="window.plugin.pogo.switchStarPortal('pokestops');return false;" title="Mark this portal as a pokestop [p]"><span></span></a>
			<a class="pogoGym" accesskey="g" onclick="window.plugin.pogo.switchStarPortal('gyms');return false;" title="Mark this portal as a PokeGym [g]"><span></span></a>
			<a class="notPogo" onclick="window.plugin.pogo.switchStarPortal('notpogo');return false;" title="Mark this portal as a removed/Not Available in Pokemon Go"><span></span></a>
			`;

		thisPlugin.setupCSS();

		const sidebarPogo = document.createElement('div');
		sidebarPogo.id = 'sidebarPogo';
		sidebarPogo.style.display = 'none';
		if (thisPlugin.isSmart) {
			const status = document.getElementById('updatestatus');
			sidebarPogo.classList.add('mobile');
			status.insertBefore(sidebarPogo, status.firstElementChild);

			const dStatus = document.createElement('div');
			dStatus.className = 'PogoStatus';
			status.insertBefore(dStatus, status.firstElementChild);
		} else {
			document.getElementById('sidebar').appendChild(sidebarPogo);
		}

		sidebarPogo.appendChild(createCounter('새 스탑', 'pokestops', promptForNewPokestops));
		sidebarPogo.appendChild(createCounter('Review required', 'classification', promptToClassifyPokestops));
		sidebarPogo.appendChild(createCounter('이동된 포탈', 'moved', promptToMovePokestops));
		sidebarPogo.appendChild(createCounter('Missing portals', 'missing', promptToRemovePokestops));
		sidebarPogo.appendChild(createCounter('새 체육관', 'gyms', promptToClassifyGyms));
		sidebarPogo.appendChild(createCounter('셀내 체육관초과', 'extraGyms', promptToVerifyGyms));

		window.addHook('portalSelected', thisPlugin.onPortalSelected);

		window.addHook('portalAdded', onPortalAdded);
		window.addHook('mapDataRefreshStart', function () {
			sidebarPogo.classList.add('refreshingData');
		});
		window.addHook('mapDataRefreshEnd', function () {
			sidebarPogo.classList.remove('refreshingData');
			refreshNewPortalsCounter();
		});
		map.on('moveend', function () {
			refreshNewPortalsCounter();
		});
		sidebarPogo.classList.add('refreshingData');

		// Layer - pokemon go portals
		stopLayerGroup = L.layerGroup();
		window.addLayerGroup('PokeStops', stopLayerGroup, true);
		gymLayerGroup = L.layerGroup();
		window.addLayerGroup('Gyms', gymLayerGroup, true);
		regionLayer = L.layerGroup();
		window.addLayerGroup('S2 Grid', regionLayer, true);

		// this layer will group all the nearby circles that are added or removed from it when the portals are added or removed
		nearbyLayerGroup = L.featureGroup();
		// this layer will group all the shaded cells and cell borders
		cellLayerGroup = L.featureGroup();
		// this layer will contain the s2 grid
		gridLayerGroup = L.layerGroup()
		// this layer will contain the gym centers for checking ex eligibility
		gymCenterLayerGroup = L.featureGroup();

		thisPlugin.addAllMarkers();

		const toolbox = document.getElementById('toolbox');

		const buttonPoGo = document.createElement('a');
		buttonPoGo.textContent = '데이터 관리';
		buttonPoGo.title = '포고 데이터 관리 메뉴';
		buttonPoGo.addEventListener('click', thisPlugin.pogoActionsDialog);
		toolbox.appendChild(buttonPoGo);

		const buttonGrid = document.createElement('a');
		buttonGrid.textContent = '설정';
		buttonGrid.title = 'Settings for S2 & PokemonGo';
		buttonGrid.addEventListener('click', e => {
			if (thisPlugin.isSmart)
				window.show('map');
			showS2Dialog();
		});
		toolbox.appendChild(buttonGrid);

		map.on('zoomend', zoomListener);
		zoomListener();
		map.on('moveend', updateMapGrid);
		updateMapGrid();
		map.on('overlayadd', function(event) {
			if (event && event.name === "S2 Grid") {
				updateMapGrid();
			}
		});

		// add ids to the links that we want to be able to hide
		const links = document.querySelectorAll('#toolbox > a');
		links.forEach(a => {
			const text = a.textContent;
			if (text == 'Region scores') {
				a.id = 'scoresLink';
			}
			if (text == 'Artifacts') {
				a.id = 'artifactLink';
			}
		});

	};

	function createCounter(title, type, callback) {
		const div = document.createElement('div');
		div.style.display = 'none';
		const sTitle = document.createElement('span');
		sTitle.textContent = title;
		const counter = document.createElement('a');
		counter.id = 'PogoCounter-' + type;
		counter.addEventListener('click', function (e) {
			callback(counter.PogoData);
			return false;
		});
		div.appendChild(sTitle);
		div.appendChild(counter);
		return div;
	}

	function updateCounter(type, data) {
		const counter = document.querySelector('#PogoCounter-' + type);
		counter.PogoData = data;
		counter.textContent = data.length;
		counter.parentNode.style.display = data.length > 0 ? '' : 'none';

		// Adjust visibility of the pane to avoid the small gap due to padding
		const pane = counter.parentNode.parentNode;
		if (data.length > 0) {
			pane.style.display = '';
			return;
		}
		let node = pane.firstElementChild;
		while (node) {
			const rowData = node.lastElementChild.PogoData;
			if (rowData && rowData.length > 0) {
				pane.style.display = '';
				return;
			}
			node = node.nextElementSibling;
		}
		pane.style.display = 'none';
	}

	// PLUGIN END //////////////////////////////////////////////////////////

	setup.info = plugin_info; //add the script info data to the function as a property
	// if IITC has already booted, immediately run the 'setup' function
	if (window.iitcLoaded) {
		setup();
	} else {
		if (!window.bootPlugins) {
			window.bootPlugins = [];
		}
		window.bootPlugins.push(setup);
	}
}

	const plugin_info = {};
	if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
		plugin_info.script = {
			version: GM_info.script.version,
			name: GM_info.script.name,
			description: GM_info.script.description
		};
	}

	// Greasemonkey. It will be quite hard to debug
	if (typeof unsafeWindow != 'undefined' || typeof GM_info == 'undefined' || GM_info.scriptHandler != 'Tampermonkey') {
		// inject code into site context
		const script = document.createElement('script');
		script.appendChild(document.createTextNode('(' + wrapperPlugin + ')(' + JSON.stringify(plugin_info) + ');'));
		(document.body || document.head || document.documentElement).appendChild(script);
	} else {
		// Tampermonkey, run code directly
		wrapperPlugin(plugin_info);
	}
})();



// Wayfaer Planner


/* forked from https://github.com/Wintervorst/iitc/raw/master/plugins/totalrecon/ */
/* eslint-env es6 */
/* eslint no-var: "error" */
/* globals L, map */
/* globals GM_info, $, dialog */

;function wrapper(plugin_info) {
	'use strict';

	// PLUGIN START ///////////////////////////////////////////////////////

	let editmarker = null;
	let isPlacingMarkers = false;

	let markercollection = [];
	let plottedmarkers = {};
	let plottedtitles = {};
	let plottedsubmitrange = {};

	// Define the layers created by the plugin, one for each marker status
	const mapLayers = {
		potential: {
			color: 'grey',
			title: 'Potentials',
			optionTitle: '신청 예정'
		},
		submitted: {
			color: 'orange',
			title: 'Submitted',
			optionTitle: '신청 완료'
		},
		live: {
			color: 'green',
			title: 'Accepted',
			optionTitle: '심사중'
		},
		rejected: {
			color: 'red',
			title: 'Rejected',
			optionTitle: '거절'
		},
		potentialedit: {
			color: 'cornflowerblue',
			title: 'Potential edit',
			optionTitle: '위치변경 예정'
		},
		sentedit: {
			color: 'purple',
			title: 'Sent edit',
			optionTitle: '위치변경 신청완료'
		},
	};

	const defaultSettings = {
		showTitles: true,
		showRadius: false,
		scriptURL: ''
	}
	let settings = defaultSettings;

	function saveSettings() {
		localStorage['wayfarer_planner_settings'] = JSON.stringify(settings);
	}

	function loadSettings() {
		const tmp = localStorage['wayfarer_planner_settings'];
		if (!tmp) {
			upgradeSettings();
			return;
		}

		try	{
			settings = JSON.parse(tmp);
		} catch (e) { // eslint-disable-line no-empty
		}
	}

	// importing from totalrecon_settings will be removed after a little while
	function upgradeSettings() {
		const tmp = localStorage['totalrecon_settings'];
		if (!tmp)
			return;

		try	{
			settings = JSON.parse(tmp);
		} catch (e) { // eslint-disable-line no-empty
		}
		saveSettings();
		localStorage.removeItem('totalrecon_settings');
	}

	function getStoredData() {
		const url = settings.scriptURL;
		if (!url)
			return;

		$.ajax({
			url: url,
			type: 'GET',
			dataType: 'text',
			success: function (data, status, header) {
				try
				{
					markercollection = JSON.parse(data);
				}
				catch (e)
				{
					console.log('Wayfarer Planner. Exception parsing response: ', e); // eslint-disable-line no-console
					alert('Wayfarer Planner. Exception parsing response.');
					return;
				}
				drawMarkers();
			},
			error: function (x, y, z) {
				console.log('Wayfarer Planner. Error message: ', x, y, z); // eslint-disable-line no-console
				alert('Wayfarer Planner. Failed to retrieve data from the scriptURL.');
			}
		});
	};

	function drawMarker(candidate) {
		if (candidate != undefined && candidate.lat != '' && candidate.lng != '') {
			addMarkerToLayer(candidate);
			addTitleToLayer(candidate);
			addCircleToLayer(candidate);
		}
	};

	function addCircleToLayer(candidate) {
		if (settings.showRadius) {
			const latlng = L.latLng(candidate.lat, candidate.lng);

			// Specify the no submit circle options
			const circleOptions = {color: 'black', opacity: 1, fillColor: 'grey', fillOpacity: 0.40, weight: 1, clickable: false, interactive: false};
			const range = 20; // Hardcoded to 20m, the universal too close for new submit range of a portal

			// Create the circle object with specified options
			const circle = new L.Circle(latlng, range, circleOptions);
			// Add the new circle
			const existingMarker = plottedmarkers[candidate.id];
			existingMarker.layer.addLayer(circle);

			plottedsubmitrange[candidate.id] = circle;
		}
	};

	function removeExistingCircle(guid) {
		const existingCircle = plottedsubmitrange[guid];
		if (existingCircle !== undefined) {
			const existingMarker = plottedmarkers[guid];
			existingMarker.layer.removeLayer(existingCircle);
			delete plottedsubmitrange[guid];
		}
	};

	function addTitleToLayer(candidate) {
		if (settings.showTitles) {
			const title = candidate.title;
			if (title != '') {
				const portalLatLng = L.latLng(candidate.lat, candidate.lng);
				const titleMarker = L.marker(portalLatLng, {
					icon: L.divIcon({
						className: 'wayfarer-planner-name',
						iconAnchor: [100,5],
						iconSize: [200,10],
						html: title
					}),
					data: candidate
				});
				const existingMarker = plottedmarkers[candidate.id];
				existingMarker.layer.addLayer(titleMarker);

				plottedtitles[candidate.id] = titleMarker;
			}
		}
	};

	function removeExistingTitle(guid) {
		const existingTitle = plottedtitles[guid];
		if (existingTitle !== undefined) {
			const existingMarker = plottedmarkers[guid];
			existingMarker.layer.removeLayer(existingTitle);
			delete plottedtitles[guid];
		}
	};

	function removeExistingMarker(guid) {
		const existingMarker = plottedmarkers[guid];
		if (existingMarker !== undefined) {
			existingMarker.layer.removeLayer(existingMarker.marker);
			removeExistingTitle(guid);
			removeExistingCircle(guid);
		}
	}

	function addMarkerToLayer(candidate) {
		removeExistingMarker(candidate.id);

		const portalLatLng = L.latLng(candidate.lat, candidate.lng);

		const layerData = mapLayers[candidate.status];
		const markerColor = layerData.color;
		const markerLayer = layerData.layer;

		const marker = createGenericMarker(portalLatLng, markerColor, {
			title: candidate.title,
			id: candidate.id,
			data: candidate,
			draggable: true
		});

		marker.on('dragend', function (e) {
			const data = e.target.options.data;
			const latlng = marker.getLatLng();
			data.lat = latlng.lat;
			data.lng = latlng.lng;

			drawInputPopop(latlng, data);
		});

		marker.on('dragstart', function (e) {
			const guid = e.target.options.data.id;
			removeExistingTitle(guid);
			removeExistingCircle(guid);
		});

		markerLayer.addLayer(marker);
		plottedmarkers[candidate.id] = {'marker': marker, 'layer': markerLayer};
	};

	function clearAllLayers() {
		Object.values(mapLayers).forEach(data => data.layer.clearLayers());

		/* clear marker storage */
		plottedmarkers = {};
		plottedtitles = {};
		plottedsubmitrange = {};
	};

	function drawMarkers() {
		clearAllLayers();
		markercollection.forEach(drawMarker);
	};

	function onMapClick(e) {
		if (isPlacingMarkers) {
			if (editmarker != null) {
				map.removeLayer(editmarker);
			}

			const marker = createGenericMarker(e.latlng, 'pink', {
				title: 'Place your mark!'
			});

			editmarker = marker;
			marker.addTo(map);

			drawInputPopop(e.latlng);
		}
	};

	function drawInputPopop(latlng, markerData) {
		const formpopup = L.popup();

		let title = '';
		let description = '';
		let id = '';
		let submitteddate = '';
		let lat = '';
		let lng = '';
		let status = 'potential';
		let imageUrl = '';

		if (markerData !== undefined) {
			id = markerData.id;
			title = markerData.title;
			description = markerData.description;
			submitteddate = markerData.submitteddate;
			status = markerData.status;
			imageUrl = markerData.candidateimageurl;
			lat = parseFloat(markerData.lat).toFixed(6);
			lng = parseFloat(markerData.lng).toFixed(6);
		} else {
			lat = latlng.lat.toFixed(6);
			lng = latlng.lng.toFixed(6);
		}

		formpopup.setLatLng(latlng);

		const options = Object.keys(mapLayers)
			.map(id => '<option value="' + id + '"' + (id == status ? ' selected="selected"' : '') + '>' + mapLayers[id].optionTitle + '</option>')
			.join('');

		let formContent = `<div style="width:250px;, font-size:20px;"><form id="submit-to-wayfarer">
			<label>상태
			<select name="status">${options}</select>
			</label>
			<label>신청자 닉네임
			<input name="nickname" value="${window.PLAYER.nickname}">
			</label>
			<label>스탑 이름
			<input name="title" type="text" autocomplete="off" placeholder="Title (required)" required value="${title}">
			</label>
			<label>부연 설명
			<input name="description" type="text" autocomplete="off" placeholder="Description" value="${description}">
			</label>
			<label>신청일자 (날자-월-년도)
			<input name="submitteddate" type="text" autocomplete="off" placeholder="dd-mm-jjjj" value="${submitteddate}">
			</label>
			<label>이미지 링크 (첨부 하면 좋습니다.)
			<input name="candidateimageurl" type="text" autocomplete="off" placeholder="http://?.googleusercontent.com/***" value="${imageUrl}">
			</label>
			<input name="id" type="hidden" value="${id}">
			<input name="lat" type="hidden" value="${lat}">
			<input name="lng" type="hidden" value="${lng}">

			<button type="submit" style="width:100%; height:40px;">등록</button>
			</form>`;

		if (id !== '') {
			formContent += '<a style="padding:4px; display: inline-block;" id="deletePortalCandidate">삭제 🗑️</a>';
		}

		if (imageUrl !== '' && imageUrl !== undefined) {
			formContent += ' <a href="' + imageUrl + '" style="padding:4px; float:right;" target="_blank">Image</a>';
		}
		formContent += ` <a href="https://www.google.com/maps?layer=c&cbll=${lat},${lng}" style="padding:4px; float:right;" target="_blank">스뷰 보기</a>`;

		formpopup.setContent(formContent + '</div>');
		formpopup.openOn(map);

		const deleteLink = formpopup._contentNode.querySelector('#deletePortalCandidate');
		if (deleteLink != null) {
			deleteLink.addEventListener('click', e => confirmDeleteCandidate(e, id));
		}
	};

	function confirmDeleteCandidate(e, id) {
		e.preventDefault();

		if (!confirm('Do you want to remove this candidate?'))
			return;

		const formData = new FormData();
		formData.append('status', 'delete');
		formData.append('id', id);

		$.ajax({
			url: settings.scriptURL,
			type: 'POST',
			data: formData,
			processData: false,
			contentType: false,
			success: function (data, status, header) {
				removeExistingMarker(id);
				map.closePopup();
			},
			error: function (x, y, z) {
				console.log('Wayfarer Planner. Error message: ', x, y, z); // eslint-disable-line no-console
				alert('Wayfarer Planner. Failed to send data to the scriptURL');
			}
		});
	}

	function markerClicked(event) {
		// bind data to edit form
		if (editmarker != null) {
			map.removeLayer(editmarker);
			editmarker = null;
		}
		drawInputPopop(event.layer.getLatLng(), event.layer.options.data);
	};

	function getGenericMarkerSvg(color) {
		const markerTemplate = `<?xml version="1.0" encoding="UTF-8"?>
			<svg xmlns="http://www.w3.org/2000/svg" baseProfile="full" viewBox="0 0 25 41">
				<path d="M1.362 18.675a12.5 12.5 0 1 1 22.276 0L12.5 40.534z" fill="%COLOR%"/>
				<path d="M1.808 18.448a12 12 0 1 1 21.384 0L12.5 39.432z" stroke="#000" stroke-opacity=".15" fill="none"/>
				<path d="M2.922 17.88a10.75 10.75 0 1 1 19.156 0L12.5 36.68z" stroke="#fff" stroke-width="1.5" stroke-opacity=".35" fill="none"/>
				<path d="M19.861 17.25L12.5 21.5l-7.361-4.25v-8.5L12.5 4.5l7.361 4.25zm-12.124-7h9.526L12.5 18.5zM12.5 13l-4.763-2.75M12.5 13l4.763-2.75M12.5 13v5.5m7.361-1.25l-3.464-2m-11.258 2l3.464-2M12.5 4.5v4" stroke="#fff" stroke-width="1.25" fill="none"/>
			</svg>`;

		return markerTemplate.replace(/%COLOR%/g, color);
	};

	function getGenericMarkerIcon(color, className) {
		return L.divIcon({
			iconSize: new L.Point(25, 41),
			iconAnchor: new L.Point(12, 41),
			html: getGenericMarkerSvg(color),
			className: className || 'leaflet-iitc-divicon-generic-marker'
		});
	};

	function createGenericMarker(ll, color, options) {
		options = options || {};

		const markerOpt = $.extend({
			icon: getGenericMarkerIcon(color || '#a24ac3')
		}, options);

		return L.marker(ll, markerOpt);
	};

	function showDialog() {
		if (window.isSmartphone())
			window.show('map');

		const html =
			`<p><label for="txtScriptUrl">방장이 주는 링크를 입력하세요.</label><br><input type="url" id="txtScriptUrl" spellcheck="false" placeholder="https://script.google.com/macros/***/exec"></p>
			 <p><a class='wayfarer-refresh'>계획표 설정</a></p>
			 <p><input type="checkbox" id="chkShowTitles"><label for="chkShowTitles">신청 이름 보기 (체크)</label></p>
			 <p><input type="checkbox" id="chkShowRadius"><label for="chkShowRadius">지름 반원 보기 (체크)</label></p>
			 <p><input type="checkbox" id="chkPlaceMarkers"><label for="chkPlaceMarkers">등록 기능 활성화</label></p>
			`;

		const container = dialog({
			width: 'auto',
			html: html,
			title: '스탑신청 계획표',
			buttons: {
				OK: function () {
					const newUrl = txtInput.value;
					if (!txtInput.reportValidity())
						return;

					if (newUrl != settings.scriptURL) {
						settings.scriptURL = txtInput.value;
						saveSettings();
						getStoredData();
					}

					container.dialog('close');
				}
			}
		});

		const div = container[0];
		const txtInput = div.querySelector('#txtScriptUrl');
		txtInput.value = settings.scriptURL;

		const linkRefresh = div.querySelector('.wayfarer-refresh');
		linkRefresh.addEventListener('click', () => {
			settings.scriptURL = txtInput.value;
			saveSettings();
			getStoredData();
		});

		const chkShowTitles = div.querySelector('#chkShowTitles');
		chkShowTitles.checked = settings.showTitles;

		chkShowTitles.addEventListener('change', e => {
			settings.showTitles = chkShowTitles.checked;
			saveSettings();
			drawMarkers();
		});

		const chkShowRadius = div.querySelector('#chkShowRadius');
		chkShowRadius.checked = settings.showRadius;
		chkShowRadius.addEventListener('change', e => {
			settings.showRadius = chkShowRadius.checked;
			saveSettings();
			drawMarkers();
		});

		const chkPlaceMarkers = div.querySelector('#chkPlaceMarkers');
		chkPlaceMarkers.checked = isPlacingMarkers;
		chkPlaceMarkers.addEventListener('change', e => {
			isPlacingMarkers = chkPlaceMarkers.checked;
			if (!isPlacingMarkers && editmarker != null) {
				map.closePopup();
				map.removeLayer(editmarker);
				editmarker = null;
			}
			//settings.isPlacingMarkers = chkPlaceMarkers.checked;
			//saveSettings();
		});

		if (!settings.scriptURL) {
			chkPlaceMarkers.disabled = true;
			chkPlaceMarkers.parentNode.classList.add('wayfarer-planner__disabled');
			linkRefresh.classList.add('wayfarer-planner__disabled');
		}
		txtInput.addEventListener('input', e => {
			chkPlaceMarkers.disabled = !txtInput.value;
			chkPlaceMarkers.parentNode.classList.toggle('wayfarer-planner__disabled', !txtInput.value);
			linkRefresh.classList.toggle('wayfarer-planner__disabled', !txtInput.value);
		});
	}

	// Initialize the plugin
	const setup = function () {
		loadSettings();

		$('<style>')
			.prop('type', 'text/css')
			.html(`.wayfarer-planner-name {
				font-size: 14px;
				font-weight: bold;
				color: gold;
				opacity: 0.7;
				text-align: center;
				text-shadow: -1px -1px #000, 1px -1px #000, -1px 1px #000, 1px 1px #000, 0 0 2px #000;
				pointer-events: none;
			}
			#txtScriptUrl {
				width: 100%;
			}
			.wayfarer-planner__disabled {
				opacity: 0.8;
				pointer-events: none;
			}
			#submit-to-wayfarer input,
			#submit-to-wayfarer select {
				width: 100%;
			}
			#submit-to-wayfarer label {
				margin-top: 5px;
				display: block;
				color: #fff;
			}
			`)
			.appendTo('head');

		$('body').on('submit','#submit-to-wayfarer', function (e) {
			e.preventDefault();
			map.closePopup();
			$.ajax({
				url: settings.scriptURL,
				type: 'POST',
				data: new FormData(e.currentTarget),
				processData: false,
				contentType: false,
				success: function (data, status, header) {
					drawMarker(data);
					if (editmarker != null) {
						map.removeLayer(editmarker);
						editmarker = null;
					}
				},
				error: function (x, y, z) {
					console.log('Wayfarer Planner. Error message: ', x, y, z); // eslint-disable-line no-console
					alert('Wayfarer Planner. Failed to send data to the scriptURL');
				}
			});
		});

		map.on('click', onMapClick);

		Object.values(mapLayers).forEach(data => {
			const layer = new L.featureGroup();
			data.layer = layer;
			window.addLayerGroup('Wayfarer - ' + data.title, layer, true);
			layer.on('click', markerClicked);
		});

		const toolbox = document.getElementById('toolbox');

		const toolboxLink = document.createElement('a');
		toolboxLink.textContent = '신청현황 설정';
		toolboxLink.title = '신청 내역 등록 설정';
		toolboxLink.addEventListener('click', showDialog);
		toolbox.appendChild(toolboxLink);

		if (settings.scriptURL) {
			getStoredData();
		} else {
			showDialog();
		}
	};

	// PLUGIN END //////////////////////////////////////////////////////////

	setup.info = plugin_info; //add the script info data to the function as a property
	// if IITC has already booted, immediately run the 'setup' function
	if (window.iitcLoaded) {
		setup();
	} else {
		if (!window.bootPlugins) {
			window.bootPlugins = [];
		}
		window.bootPlugins.push(setup);
	}
}
// wrapper end

(function() {
	const plugin_info = {};
	if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
		plugin_info.script = {
			version: GM_info.script.version,
			name: GM_info.script.name,
			description: GM_info.script.description
		};
	}

	// Greasemonkey. It will be quite hard to debug
	if (typeof unsafeWindow != 'undefined' || typeof GM_info == 'undefined' || GM_info.scriptHandler != 'Tampermonkey') {
		// inject code into site context
		const script = document.createElement('script');
		script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(plugin_info) + ');'));
		(document.body || document.head || document.documentElement).appendChild(script);
	} else {
		// Tampermonkey, run code directly
		wrapper(plugin_info);
	}
})();
