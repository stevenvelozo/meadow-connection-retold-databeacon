/**
 * Unit tests for meadow-connection-retold-databeacon
 *
 * Exercises connectAsync + dispatchRequest against a local HTTP mock that
 * plays the role of the ultravisor coordinator. Verifies AffinityKey routing,
 * Outputs envelope unwrapping, and introspection delegation.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const Chai = require('chai');
const Expect = Chai.expect;
const libHTTP = require('http');

const libConnection = require('../source/Meadow-Connection-RetoldDataBeacon.js');

// ------------------------------------------------------------------
// Ultravisor mock server
// ------------------------------------------------------------------

let _Server = null;
let _Port = 0;
let _Requests = [];
let _DispatchResponder = null;

const startServer = function (fCallback)
{
	_Requests = [];
	_DispatchResponder = null;

	_Server = libHTTP.createServer((pRequest, pResponse) =>
	{
		let tmpData = '';
		pRequest.on('data', (pChunk) => { tmpData += pChunk; });
		pRequest.on('end', () =>
		{
			let tmpRecord = { method: pRequest.method, path: pRequest.url, headers: pRequest.headers, body: tmpData };
			_Requests.push(tmpRecord);

			if (pRequest.url === '/1.0/Authenticate')
			{
				pResponse.writeHead(200, {
					'Content-Type': 'application/json',
					'Set-Cookie': 'ultravisor.sid=testcookie; Path=/'
				});
				pResponse.end(JSON.stringify({ Success: true }));
				return;
			}

			if (pRequest.url === '/Beacon/Work/Dispatch')
			{
				let tmpBody = tmpData.length > 0 ? JSON.parse(tmpData) : {};
				if (_DispatchResponder)
				{
					_DispatchResponder(tmpBody, pRequest, pResponse);
				}
				else
				{
					pResponse.writeHead(200, { 'Content-Type': 'application/json' });
					pResponse.end(JSON.stringify({ Outputs: { Status: 200, Body: '{}' } }));
				}
				return;
			}

			pResponse.writeHead(404, { 'Content-Type': 'application/json' });
			pResponse.end(JSON.stringify({ Error: 'no mock handler' }));
		});
	});

	_Server.listen(0, '127.0.0.1', () =>
	{
		_Port = _Server.address().port;
		fCallback(null);
	});
};

const stopServer = function (fCallback)
{
	if (_Server)
	{
		_Server.close(fCallback);
		_Server = null;
	}
	else
	{
		fCallback(null);
	}
};

const makeFable = function (pSettings)
{
	let tmpFable = {
		isFable: true,
		settings: pSettings || {},
		services: {},
		servicesMap: {},
		Logging:
		{
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
			trace: () => {}
		},
		getUUID: () => 'test-uuid-' + Math.random().toString(36).substring(2)
	};
	return tmpFable;
};

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

suite('Meadow-Connection-RetoldDataBeacon', () =>
{
	suiteSetup((fDone) => startServer(fDone));
	suiteTeardown((fDone) => stopServer(fDone));

	setup(() =>
	{
		_Requests = [];
		_DispatchResponder = null;
	});

	const mockURL = () => 'http://127.0.0.1:' + _Port;

	// --------------------------------------------------------------
	suite('Construction & config', () =>
	{
		test('reads configuration from fable.settings.RetoldDataBeacon', () =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon:
				{
					UltravisorURL: mockURL(),
					TargetBeaconName: 'customer-x',
					TargetConnectionHash: 'bookstore-mssql',
					UserName: 'alice',
					Password: 'pw',
					TimeoutMs: 5000
				}
			});
			let tmpConn = new libConnection(tmpFable);
			Expect(tmpConn._UltravisorURL).to.equal(mockURL());
			Expect(tmpConn._TargetBeaconName).to.equal('customer-x');
			Expect(tmpConn._TargetConnectionHash).to.equal('bookstore-mssql');
			Expect(tmpConn._UserName).to.equal('alice');
			Expect(tmpConn._TimeoutMs).to.equal(5000);
		});

		test('constructor options override fable.settings', () =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon: { UltravisorURL: 'http://wrong', TargetBeaconName: 'wrong', TargetConnectionHash: 'wrong' }
			});
			let tmpConn = new libConnection(tmpFable, { UltravisorURL: mockURL(), TargetBeaconName: 'right', TargetConnectionHash: 'right-hash' });
			Expect(tmpConn._UltravisorURL).to.equal(mockURL());
			Expect(tmpConn._TargetBeaconName).to.equal('right');
			Expect(tmpConn._TargetConnectionHash).to.equal('right-hash');
		});
	});

	// --------------------------------------------------------------
	suite('connectAsync', () =>
	{
		test('authenticates against ultravisor and registers as singleton', (fDone) =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon: { UltravisorURL: mockURL(), TargetBeaconName: 'customer-x', TargetConnectionHash: 'bookstore-mssql', UserName: 'alice', Password: 'p' }
			});
			let tmpConn = new libConnection(tmpFable);
			tmpConn.connectAsync((pError) =>
			{
				Expect(pError).to.equal(null);
				Expect(tmpConn.connected).to.equal(true);
				Expect(tmpFable.MeadowRetoldDataBeaconProvider).to.equal(tmpConn);

				let tmpAuthReq = _Requests.find((r) => r.path === '/1.0/Authenticate');
				Expect(tmpAuthReq).to.be.an('object');
				let tmpBody = JSON.parse(tmpAuthReq.body);
				Expect(tmpBody.UserName).to.equal('alice');
				fDone();
			});
		});

		test('rejects when UltravisorURL is missing', (fDone) =>
		{
			let tmpFable = makeFable({ RetoldDataBeacon: { TargetBeaconName: 'x' } });
			let tmpConn = new libConnection(tmpFable);
			tmpConn.connectAsync((pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('UltravisorURL');
				Expect(tmpConn.connected).to.equal(false);
				fDone();
			});
		});

		test('rejects when TargetBeaconName is missing', (fDone) =>
		{
			let tmpFable = makeFable({ RetoldDataBeacon: { UltravisorURL: mockURL(), TargetConnectionHash: 'x' } });
			let tmpConn = new libConnection(tmpFable);
			tmpConn.connectAsync((pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('TargetBeaconName');
				fDone();
			});
		});

		test('rejects when TargetConnectionHash is missing', (fDone) =>
		{
			let tmpFable = makeFable({ RetoldDataBeacon: { UltravisorURL: mockURL(), TargetBeaconName: 'x' } });
			let tmpConn = new libConnection(tmpFable);
			tmpConn.connectAsync((pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('TargetConnectionHash');
				fDone();
			});
		});
	});

	// --------------------------------------------------------------
	suite('dispatchRequest', () =>
	{
		test('wraps the request as a MeadowProxy:Request work item with the TargetBeaconName as AffinityKey', (fDone) =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon: { UltravisorURL: mockURL(), TargetBeaconName: 'customer-q', TargetConnectionHash: 'bookstore-mssql', UserName: 'bob' }
			});
			let tmpConn = new libConnection(tmpFable);

			_DispatchResponder = (pWorkItem, pRequest, pResponse) =>
			{
				Expect(pWorkItem.Capability).to.equal('MeadowProxy');
				Expect(pWorkItem.Action).to.equal('Request');
				Expect(pWorkItem.AffinityKey).to.equal('customer-q');
				Expect(pWorkItem.Settings.Method).to.equal('GET');
				Expect(pWorkItem.Settings.Path).to.equal('/1.0/bookstore-mssql/Book');
				Expect(pWorkItem.Settings.RemoteUser).to.equal('bob');

				pResponse.writeHead(200, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({
					Outputs:
					{
						Status: 200,
						Body: JSON.stringify([{ IDBook: 1 }])
					}
				}));
			};

			tmpConn.connectAsync((pAuthError) =>
			{
				Expect(pAuthError).to.equal(null);
				tmpConn.dispatchRequest({ Method: 'GET', Path: '/1.0/bookstore-mssql/Book' }, (pError, pResponseBody) =>
				{
					Expect(pError).to.equal(null);
					Expect(pResponseBody).to.equal('[{"IDBook":1}]');
					fDone();
				});
			});
		});

		test('surfaces a non-2xx remote status as a callback error', (fDone) =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon: { UltravisorURL: mockURL(), TargetBeaconName: 'customer-q', TargetConnectionHash: 'bookstore-mssql' }
			});
			let tmpConn = new libConnection(tmpFable);

			_DispatchResponder = (pWorkItem, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({
					Outputs: { Status: 500, Body: 'oops' }
				}));
			};

			tmpConn.connectAsync(() =>
			{
				tmpConn.dispatchRequest({ Method: 'GET', Path: '/1.0/Book' }, (pError) =>
				{
					Expect(pError).to.be.an('error');
					Expect(pError.message).to.contain('500');
					fDone();
				});
			});
		});

		test('errors cleanly when called before connect', (fDone) =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon: { UltravisorURL: mockURL(), TargetBeaconName: 'customer-q', TargetConnectionHash: 'bookstore-mssql' }
			});
			let tmpConn = new libConnection(tmpFable);
			tmpConn.dispatchRequest({ Method: 'GET', Path: '/1.0/Book' }, (pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('not connected');
				fDone();
			});
		});
	});

	// --------------------------------------------------------------
	suite('introspection delegation', () =>
	{
		test('listTables dispatches DataBeaconAccess:ListTables', (fDone) =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon: { UltravisorURL: mockURL(), TargetBeaconName: 'customer-q', TargetConnectionHash: 'bookstore-mssql', IDBeaconConnection: 42 }
			});
			let tmpConn = new libConnection(tmpFable);

			_DispatchResponder = (pWorkItem, pRequest, pResponse) =>
			{
				Expect(pWorkItem.Capability).to.equal('DataBeaconAccess');
				Expect(pWorkItem.Action).to.equal('ListTables');
				Expect(pWorkItem.Settings.IDBeaconConnection).to.equal(42);

				pResponse.writeHead(200, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({ Outputs: { Tables: [{ TableName: 'Book' }] } }));
			};

			tmpConn.connectAsync(() =>
			{
				tmpConn.listTables((pError, pResult) =>
				{
					Expect(pError).to.equal(null);
					Expect(pResult.Tables).to.have.length(1);
					Expect(pResult.Tables[0].TableName).to.equal('Book');
					fDone();
				});
			});
		});

		test('close() clears state and unregisters singleton', (fDone) =>
		{
			let tmpFable = makeFable({
				RetoldDataBeacon: { UltravisorURL: mockURL(), TargetBeaconName: 'customer-q', TargetConnectionHash: 'bookstore-mssql' }
			});
			let tmpConn = new libConnection(tmpFable);
			tmpConn.connectAsync(() =>
			{
				Expect(tmpFable.MeadowRetoldDataBeaconProvider).to.equal(tmpConn);
				tmpConn.close((pError) =>
				{
					Expect(pError).to.equal(null);
					Expect(tmpConn.connected).to.equal(false);
					Expect(tmpFable.MeadowRetoldDataBeaconProvider).to.equal(undefined);
					fDone();
				});
			});
		});

		test('createTable returns an error (not supported remotely)', (fDone) =>
		{
			let tmpFable = makeFable({});
			let tmpConn = new libConnection(tmpFable);
			tmpConn.createTable({}, (pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('not supported');
				fDone();
			});
		});
	});
});
