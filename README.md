# meadow-connection-retold-databeacon

A [meadow](https://github.com/stevenvelozo/meadow) connection that relays CRUD and introspection through an [Ultravisor](https://github.com/stevenvelozo/ultravisor) mesh to a remote [retold-databeacon](https://github.com/stevenvelozo/retold-databeacon) agent.

When a BeaconConnection row has `Type = 'RetoldDataBeacon'`, meadow-connection-manager loads this module. The pair with the `MeadowProxy` capability on the remote databeacon gives you introspection, REST, CRUD, and raw SQL against a customer database transparently — no VPN, no vendor SQL client.

## Install

```bash
npm install meadow-connection-retold-databeacon
```

## Configuration

```javascript
{
    Type: 'RetoldDataBeacon',
    UltravisorURL: 'https://ultravisor.noc.example',
    TargetBeaconName: 'customer-acme-prod',
    UserName: 'engineer-alice',
    Password: 'hunter2',
    TimeoutMs: 30000,            // optional, default 30000
    IDBeaconConnection: 1        // optional, remote BeaconConnection ID for introspection
}
```

## Routing

`TargetBeaconName` becomes the ultravisor `AffinityKey` on every dispatch. The first work item with this key binds the coordinator's affinity slot to whichever registered beacon picks it up — typically deterministic when each customer has exactly one databeacon registered.

## Architecture

```
┌──────────────────┐   dispatch   ┌──────────────┐   push   ┌────────────────────┐
│ meadow provider  │─────────────▶│  ultravisor  │─────────▶│ remote databeacon  │
│ RetoldDataBeacon │              │  coordinator │          │ MeadowProxy        │
└──────────────────┘              └──────────────┘          │  → localhost:PORT  │
         ▲                                                   │    /1.0/<Entity>   │
         │                                                   └────────────────────┘
         │ { Method, Path, Body }                                      │
         │                                                              │
┌──────────────────┐                                                    │
│ this connection  │◀───────────────────── JSON response ───────────────┘
└──────────────────┘
```

The connection owns a `fable-ultravisor-client` handle. The meadow core provider `Meadow-Provider-RetoldDataBeacon` calls `this.dispatchRequest({Method, Path, Body}, cb)` on each CRUD operation, the request is wrapped as a `MeadowProxy:Request` work item, ultravisor routes it to the bound beacon, the remote `MeadowProxy` handler runs the HTTP request against its own localhost REST API, and the JSON response flows back.

## License

MIT — see [LICENSE](LICENSE).
