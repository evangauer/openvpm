# Turning on the ambulatory workspace

The solo veterinarian guide moved to the help site:
[Run a solo practice](https://docs.openvpm.com/guides/run-a-solo-practice).

This page keeps the one step that only a server operator can do.

The optional field workflow (**Start field visit** on patient charts, **Bill
now, finish notes later**, and the dashboard's **Unfinished field visits**)
stays hidden until the installation allows it. Set this in the server's
environment and restart the app:

```sh
AMBULATORY_WORKSPACE_ENABLED=true
```

A clinic admin can then open **Settings → Practice Info**, turn on
**Ambulatory workspace**, choose measurement units and a body condition
scale, optionally turn on **Compact closeout**, and save. Nothing changes for
scheduled clinic visits.

- [Set up self-hosted Stripe payments](self-hosted-payments.md)
- [Set up self-hosted SMS](self-hosted-sms.md)
- [Your data: export, backup, and import](your-data.md)
