/**
 * Meadow connection: remote retold-databeacon via Ultravisor
 *
 * When a BeaconConnection row has `Type = 'RetoldDataBeacon'`, this service
 * is instantiated. It owns a fable-ultravisor-client handle, authenticates
 * against the NOC's ultravisor, and exposes a `dispatchRequest` method that
 * the `Meadow-Provider-RetoldDataBeacon` provider (in meadow core) uses to
 * relay CRUD operations to the remote beacon.
 *
 * Configuration (via fable.settings.RetoldDataBeacon or constructor options):
 *   - UltravisorURL     (required) — base URL of the ultravisor coordinator
 *   - TargetBeaconName  (required) — stable name of the customer-side beacon;
 *                                    used as the AffinityKey on every dispatch
 *   - UserName          (optional) — ultravisor auth username
 *   - Password          (optional) — ultravisor auth password
 *   - TimeoutMs         (optional) — per-request timeout, default 30000
 *
 * Introspection:
 *   - listTables                 → DataBeaconAccess:ListTables
 *   - introspectDatabaseSchema   → DataBeaconManagement:Introspect
 *
 * Multi-connection note: this module sets `fable.MeadowRetoldDataBeaconProvider`
 * to `this` on connect. If two RetoldDataBeacon connections coexist in the
 * same process, the later connect overwrites the earlier. That is acceptable
 * for v1 (engineer-laptop scenario) and is tracked in the implementation
 * plan's "Overlooked risks" section.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libFableUltravisorClient = require('fable-ultravisor-client');

const DEFAULT_TIMEOUT_MS = 30000;

class MeadowConnectionRetoldDataBeacon extends libFableServiceProviderBase
{
	constructor(pFable, pManifest, pServiceHash)
	{
		super(pFable, pManifest, pServiceHash);

		this.serviceType = 'MeadowConnectionRetoldDataBeacon';

		this.connected = false;

		// Config precedence: constructor options > fable.settings.RetoldDataBeacon
		let tmpFallback = (this.fable && this.fable.settings && this.fable.settings.RetoldDataBeacon) || {};
		let tmpOpts = this.options || {};

		this._UltravisorURL = tmpOpts.UltravisorURL || tmpFallback.UltravisorURL || '';
		this._TargetBeaconName = tmpOpts.TargetBeaconName || tmpFallback.TargetBeaconName || '';
		this._UserName = tmpOpts.UserName || tmpFallback.UserName || '';
		this._Password = (typeof (tmpOpts.Password) === 'string') ? tmpOpts.Password
							: (typeof (tmpFallback.Password) === 'string') ? tmpFallback.Password
							: '';
		this._TimeoutMs = tmpOpts.TimeoutMs || tmpFallback.TimeoutMs || DEFAULT_TIMEOUT_MS;

		// Lazy: the client is built on connect so configure() style changes
		// can reset state cleanly.
		this._Client = null;
	}

	// ─────────────────────────────────────────────
	//  Lifecycle
	// ─────────────────────────────────────────────

	connect()
	{
		this.connectAsync();
	}

	connectAsync(fCallback)
	{
		let tmpCallback = fCallback || (() => { });

		if (!this._UltravisorURL)
		{
			this.log.error('Meadow-Connection-RetoldDataBeacon: UltravisorURL is required (fable.settings.RetoldDataBeacon.UltravisorURL or constructor options).');
			return tmpCallback(new Error('Meadow-Connection-RetoldDataBeacon: UltravisorURL is required.'));
		}
		if (!this._TargetBeaconName)
		{
			this.log.error('Meadow-Connection-RetoldDataBeacon: TargetBeaconName is required.');
			return tmpCallback(new Error('Meadow-Connection-RetoldDataBeacon: TargetBeaconName is required.'));
		}

		if (this.connected && this._Client)
		{
			this.log.warn('Meadow-Connection-RetoldDataBeacon: already connected — reusing existing session.');
			this.fable.MeadowRetoldDataBeaconProvider = this;
			return tmpCallback(null, this._Client);
		}

		this._Client = new libFableUltravisorClient(this.fable,
			{
				UltravisorURL: this._UltravisorURL,
				UserName: this._UserName,
				Password: this._Password
			});

		this.log.info(`Meadow-Connection-RetoldDataBeacon: authenticating against ${this._UltravisorURL} as [${this._UserName || '(anonymous)'}] for beacon [${this._TargetBeaconName}]`);

		this._Client.authenticate((pError) =>
		{
			if (pError)
			{
				this.log.error(`Meadow-Connection-RetoldDataBeacon: authentication failed — ${pError.message}`);
				return tmpCallback(pError);
			}

			this.connected = true;

			// Register as the singleton transport so the meadow core provider
			// (Meadow-Provider-RetoldDataBeacon) can find us.
			this.fable.MeadowRetoldDataBeaconProvider = this;

			this.log.info(`Meadow-Connection-RetoldDataBeacon: connected. Routing through beacon [${this._TargetBeaconName}].`);
			return tmpCallback(null, this._Client);
		});
	}

	close(fCallback)
	{
		let tmpCallback = fCallback || (() => { });
		this.connected = false;
		this._Client = null;
		if (this.fable.MeadowRetoldDataBeaconProvider === this)
		{
			delete this.fable.MeadowRetoldDataBeaconProvider;
		}
		return tmpCallback(null);
	}

	// ─────────────────────────────────────────────
	//  Dispatch — called by Meadow-Provider-RetoldDataBeacon
	// ─────────────────────────────────────────────

	/**
	 * Dispatch an HTTP request descriptor to the remote databeacon via
	 * ultravisor. Routed by AffinityKey = TargetBeaconName.
	 *
	 * @param {object} pRequest - { Method, Path, Body }
	 * @param {function} fCallback - function(pError, pResponseBodyString)
	 */
	dispatchRequest(pRequest, fCallback)
	{
		if (!this.connected || !this._Client)
		{
			return fCallback(new Error('Meadow-Connection-RetoldDataBeacon: not connected.'));
		}

		let tmpWorkItem = {
			Capability: 'MeadowProxy',
			Action: 'Request',
			Settings:
			{
				Method: pRequest.Method || 'GET',
				Path: pRequest.Path || '',
				Body: pRequest.Body || '',
				RemoteUser: this._UserName || ''
			},
			AffinityKey: this._TargetBeaconName,
			TimeoutMs: this._TimeoutMs
		};

		this._Client.dispatch(tmpWorkItem, (pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}

			// The MeadowProxy handler returns { Status, Body } in the Outputs
			// envelope. Tolerate a few shapes here so this module survives
			// minor changes to the coordinator's response envelope.
			let tmpOutputs = (pResult && pResult.Outputs) || pResult || {};
			let tmpStatus = tmpOutputs.Status;
			let tmpBody = tmpOutputs.Body;

			if (typeof (tmpStatus) === 'number' && tmpStatus >= 400)
			{
				return fCallback(new Error(`Remote databeacon returned HTTP ${tmpStatus}: ${(tmpBody || '').substring(0, 200)}`));
			}

			return fCallback(null, tmpBody || '');
		});
	}

	// ─────────────────────────────────────────────
	//  Introspection — delegated to the remote beacon
	// ─────────────────────────────────────────────

	listTables(fCallback)
	{
		this._dispatchAction('DataBeaconAccess', 'ListTables',
			{ IDBeaconConnection: this._defaultConnectionID() }, fCallback);
	}

	introspectTableSchema(pTableName, fCallback)
	{
		// Introspection is at the management capability. The remote beacon
		// only supports "introspect all" today, so this surfaces the table
		// details from the wider result set.
		this._dispatchAction('DataBeaconManagement', 'Introspect',
			{ IDBeaconConnection: this._defaultConnectionID() },
			(pError, pResult) =>
			{
				if (pError) { return fCallback(pError); }
				let tmpTables = (pResult && pResult.Tables) || [];
				let tmpMatch = tmpTables.find((pT) => pT.TableName === pTableName);
				return fCallback(null, tmpMatch || null);
			});
	}

	introspectDatabaseSchema(fCallback)
	{
		this._dispatchAction('DataBeaconManagement', 'Introspect',
			{ IDBeaconConnection: this._defaultConnectionID() }, fCallback);
	}

	/**
	 * Default remote connection ID used by introspection calls. The target
	 * beacon may host multiple BeaconConnections (one per customer DB); the
	 * remote ID must be supplied through fable.settings.RetoldDataBeacon
	 * or overridden per-call.
	 */
	_defaultConnectionID()
	{
		let tmpFallback = (this.fable && this.fable.settings && this.fable.settings.RetoldDataBeacon) || {};
		return (this.options && this.options.IDBeaconConnection) || tmpFallback.IDBeaconConnection || 1;
	}

	/**
	 * Internal — dispatch an arbitrary beacon action and return the Outputs.
	 */
	_dispatchAction(pCapability, pAction, pSettings, fCallback)
	{
		if (!this.connected || !this._Client)
		{
			return fCallback(new Error('Meadow-Connection-RetoldDataBeacon: not connected.'));
		}

		this._Client.dispatch(
			{
				Capability: pCapability,
				Action: pAction,
				Settings: pSettings || {},
				AffinityKey: this._TargetBeaconName,
				TimeoutMs: this._TimeoutMs
			},
			(pError, pResult) =>
			{
				if (pError) { return fCallback(pError); }
				let tmpOutputs = (pResult && pResult.Outputs) || pResult || {};
				return fCallback(null, tmpOutputs);
			});
	}

	// ─────────────────────────────────────────────
	//  Introspection no-ops for interface parity
	// ─────────────────────────────────────────────

	// Remote DBs handle their own DDL. These stubs exist so downstream
	// meadow consumers calling them do not crash — they return errors
	// indicating the operation is not supported remotely.

	createTable(pSchema, fCallback)
	{
		return fCallback(new Error('Meadow-Connection-RetoldDataBeacon: createTable is not supported on remote connections.'));
	}

	createTables(pSchema, fCallback)
	{
		return fCallback(new Error('Meadow-Connection-RetoldDataBeacon: createTables is not supported on remote connections.'));
	}

	generateCreateTableStatement()
	{
		return '';
	}

	generateDropTableStatement()
	{
		return '';
	}
}

module.exports = MeadowConnectionRetoldDataBeacon;
