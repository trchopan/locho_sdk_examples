import 'package:http/http.dart' as http;
import 'package:locho_flutter/locho_flutter.dart';

abstract interface class Pairing {
  String get hostId;
  String get service;
  String get serviceType;
  Future<String> export();
}

abstract interface class Attachment {
  Uri get httpBaseUri;
  Stream<LochoState> get states;
}

abstract interface class TunnelClient {
  Future<Attachment> attach(Pairing ticket);
  Future<void> close();
}

class SessionDependencies {
  final Future<Pairing> Function(String) parse;
  final Future<TunnelClient> Function() create;
  final http.Client Function() httpClient;
  final Duration cleanupTimeout;
  final Duration requestTimeout;
  const SessionDependencies({
    required this.parse,
    required this.create,
    required this.httpClient,
    this.cleanupTimeout = const Duration(seconds: 15),
    this.requestTimeout = const Duration(seconds: 15),
  });
  factory SessionDependencies.native() => SessionDependencies(
    parse: (text) async => _Ticket(await LochoTicket.parse(text)),
    create: () async => _Client(await LochoClient.create()),
    httpClient: http.Client.new,
  );
}

class _Ticket implements Pairing {
  final LochoTicket ticket;
  _Ticket(this.ticket);
  @override
  String get hostId => ticket.hostId;
  @override
  String get service => ticket.service;
  @override
  String get serviceType => ticket.serviceType;
  @override
  Future<String> export() => ticket.export();
}

class _Client implements TunnelClient {
  final LochoClient client;
  _Client(this.client);
  @override
  Future<Attachment> attach(Pairing ticket) async =>
      _Attachment(await client.attach(ticket: (ticket as _Ticket).ticket));
  @override
  Future<void> close() => client.close();
}

class _Attachment implements Attachment {
  final LochoAttachment attachment;
  _Attachment(this.attachment);
  @override
  Uri get httpBaseUri => attachment.httpBaseUri;
  @override
  Stream<LochoState> get states =>
      attachment.statuses.map((value) => value.state);
}
