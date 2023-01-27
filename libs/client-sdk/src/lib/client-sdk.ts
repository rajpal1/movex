import io, { Socket } from 'socket.io-client';
import { ClientSdkIO as SdkIO } from './io';
import {
  AnyIdentifiableRecord,
  ClientResource,
  OnlySessionCollectionMapOfResourceKeys,
  ResourceIdentifier,
  SessionMatch,
  SessionResource,
  SessionStoreCollectionMap,
  UnidentifiableModel,
  UnknownIdentifiableRecord,
  UnknownRecord,
  WsResponseResultPayload,
} from './types';
import { getRandomInt } from './util';
import { Pubsy } from 'ts-pubsy';
import { AsyncResult } from 'ts-async-results';
import { Err, Ok } from 'ts-results';
import { PromiseDelegate } from 'promise-delegate';

type Events = Pick<SdkIO.MsgToResponseMap, 'updateResource' | 'removeResource'>;

type RequestsCollectionMapBase = Record<string, [unknown, unknown]>;

export class ClientSdk<
  ClientInfo extends UnknownRecord = {},
  ResourceCollectionMap extends Record<
    string,
    UnknownIdentifiableRecord
  > = Record<string, AnyIdentifiableRecord>,
  RequestsCollectionMap extends RequestsCollectionMapBase = Record<
    string,
    [any, any]
  >,
  SessionCollectionMap extends SessionStoreCollectionMap<ResourceCollectionMap> = SessionStoreCollectionMap<ResourceCollectionMap>,
  SessionCollectionMapOfResourceKeys extends OnlySessionCollectionMapOfResourceKeys<ResourceCollectionMap> = OnlySessionCollectionMapOfResourceKeys<ResourceCollectionMap>
> {
  private socketInstance: Socket;

  private socketConnectionDelegate = new PromiseDelegate<Socket>(true);

  private pubsy = new Pubsy<
    Events & {
      _socketConnect: Socket;
      _socketDisconnect: undefined;

      // Broadcasts
      // TODO: This could be typed
      broadcastedMsg: {
        event: string;
        msg: unknown;
      };
    }
  >();

  private logger: typeof console;

  private userId: string;

  constructor(
    private config: {
      url: string;
      userId?: string; // Pass in a userId or allow the SDK to generate a random one
      apiKey: string;
      logger?: typeof console;
      waitForResponseMs?: number;
    }
  ) {
    this.logger = config.logger || console;
    this.config.waitForResponseMs = this.config.waitForResponseMs || 15 * 1000;

    // TODO: This should probably come from the server when it is random, b/c of duplicates?
    this.userId =
      config.userId || String(getRandomInt(10000000000, 999999999999));

    this.socketInstance = io(this.config.url, {
      reconnectionDelay: 1000,
      reconnection: true,
      transports: ['websocket'],
      agent: false,
      upgrade: true,
      rejectUnauthorized: false,
      query: {
        userId: this.userId,
        apiKey: this.config.apiKey, // This could change
      },
      autoConnect: false,
    });

    let unsubscribeOnSocketDisconnnect: Function[] = [];

    this.socketInstance.on('connect', () => {
      unsubscribeOnSocketDisconnnect = this.handleIncomingMessage(
        this.socketInstance
      );

      // TOOD: Not sure why the 100ms delay needed???
      setTimeout(() => {
        this.socketConnectionDelegate.resolve(this.socketInstance);

        console.log('[ClientSdk] Connected with id', this.socketInstance.id);
      }, 100);

      this.pubsy.publish('_socketConnect', this.socketInstance);

      // Set the connection promise to a real socket
      // This needs to be at the end!
      // this.socketConnection
      // this.socketConnection = Promise.resolve(this.socketInstance);

      // TODO: not sure why this needs a timeout here but it seems to be working like this
      // setTimeout(() => {
      //   // Take care or previously called socketConnection.promise
      //   if (
      //     this.socketConnectionObj.connected === false &&
      //     this.socketConnectionObj.promiseDelegate.settled === false
      //   ) {
      //     this.socketConnectionObj.promiseDelegate.resolve(this.socketInstance);
      //   }

      //   this.socketConnectionObj = {
      //     connected: true,
      //     promise: Promise.resolve(this.socketInstance),
      //   };

      //   console.log('works wi 10')
      // }, 10);

      this.logger.info('[ClientSdk] Connected Succesfully');
    });

    this.socketInstance.on('disconnect', () => {
      this.pubsy.publish('_socketDisconnect', undefined);

      // TODO: add delegate
      this.socketConnectionDelegate = new PromiseDelegate<Socket>(true);

      // TODO: Test that the unsubscribptions work correctly
      unsubscribeOnSocketDisconnnect.forEach((unsubscribe) => unsubscribe());
    });
  }

  private handleIncomingMessage(socket: Socket) {
    const unsubscribers: Function[] = [];

    // Resource

    const updateResourceHandler = (
      res: WsResponseResultPayload<
        SdkIO.MsgToResponseMap['updateResource'],
        unknown
      >
    ) => {
      if (res.ok) {
        this.pubsy.publish('updateResource', res.val);
      }
    };

    socket.on(SdkIO.msgNames.updateResource, updateResourceHandler);

    unsubscribers.push(() =>
      socket.off(SdkIO.msgNames.updateResource, updateResourceHandler)
    );

    // BroadcastedEvents
    // TODO: Reuse this from one place only since it's written in the backend as well
    const BROADCAST_PREFIX = 'broadcast::';
    const onBroadcastsHandler = (event: string, msg: unknown) => {
      if (event.slice(0, BROADCAST_PREFIX.length) !== BROADCAST_PREFIX) {
        // Only handle broadcast messages
        return;
      }

      console.log(
        '[client sdk] broaasting',
        event.slice(BROADCAST_PREFIX.length)
      );

      this.pubsy.publish('broadcastedMsg', {
        event: event.slice(BROADCAST_PREFIX.length), // Remove the prefix
        msg,
      });
    };

    socket.onAny(onBroadcastsHandler);

    unsubscribers.push(() => {
      socket.offAny(onBroadcastsHandler);
    });

    return unsubscribers;

    // Handle Remove resource

    // [SdkIO.msgNames.updateResource, SdkIO.msgNames.removeResource].forEach(
    //   (key) => {
    //     socket.on(
    //       SdkIO.msgs[key].res,
    //       // (res: WsResponseResultPayload<any, unknown>) => {
    //       (res) => {
    //         // console.log('[client sdk] going to publish', key, res);
    //         if (res.ok) {
    //           this.pubsy.publish(key, res.val);
    //         }
    //       }
    //     );
    //   }
    // );
  }

  get socketConnection() {
    return this.socketConnectionDelegate.promise;
  }

  connect() {
    return this.socketInstance.connect();
  }

  disconnect() {
    this.socketInstance.close();
  }

  onConnect(fn: (socket: Socket) => void) {
    return this.pubsy.subscribe('_socketConnect', fn);
  }

  onDisconnect(fn: () => void) {
    return this.pubsy.subscribe('_socketDisconnect', fn);
  }

  // TODOL this will be needed most likely for the Identity Management
  // getClient() {
  //   return AsyncResult.toAsyncResult<TRes, unknown>(
  //     new Promise((resolve, reject) => {
  //       this.socket?.emit(
  //         ServerSdkIO.msgs[k].req,
  //         req,
  //         withTimeout(
  //           (res: WsResponseResultPayload<TRes, unknown>) => {
  //             if (res.ok) {
  //               this.logger.info('[ServerSdk]', reqId, 'Response Ok');
  //               resolve(new Ok(res.val));
  //             } else {
  //               this.logger.warn('[ServerSdk]', reqId, 'Response Err:', res);
  //               reject(new Err(res.val));
  //             }
  //           },
  //           () => {
  //             this.logger.warn('[ServerSdk]', reqId, 'Request Timeout:', req);
  //             reject(new Err('RequestTimeout')); // TODO This error could be typed better using a result error
  //           },
  //           this.config.waitForResponseMs
  //         )
  //       );
  //     }).catch((e) => e) as any
  //   );
  // }

  // on<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void) {
  //   return this.pubsy.subscribe(event, fn);
  // }

  createResource<
    TResourceType extends SessionCollectionMapOfResourceKeys,
    TResourceData extends UnidentifiableModel<
      SessionCollectionMap[TResourceType]
    >
  >(req: {
    resourceType: TResourceType;
    resourceData: TResourceData;
    resourceId?: SessionResource['id'];
  }) {
    return this.emitAndAcknowledgeResources('createResource', {
      resourceIdentifier: {
        resourceType: req.resourceType,
        resourceId: req.resourceId,
      },
      resourceData: req.resourceData,
    });
  }

  updateResource<
    TResourceType extends SessionCollectionMapOfResourceKeys,
    TResourceData extends ResourceCollectionMap[TResourceType]
  >(
    resourceIdentifier: ResourceIdentifier<TResourceType>,
    resourceData: Partial<UnidentifiableModel<TResourceData>>
  ) {
    return this.emitAndAcknowledgeResources('updateResource', {
      resourceIdentifier,
      resourceData,
    });
  }

  removeResource<TResourceType extends SessionCollectionMapOfResourceKeys>(
    resourceIdentifier: ResourceIdentifier<TResourceType>
  ) {
    return this.emitAndAcknowledgeResources('removeResource', {
      resourceIdentifier,
    });
  }

  getResource<TResourceType extends SessionCollectionMapOfResourceKeys>(
    resourceIdentifier: ResourceIdentifier<TResourceType>
  ) {
    return this.emitAndAcknowledgeResources('getResource', {
      resourceIdentifier,
    });
  }

  observeResource<TResourceType extends SessionCollectionMapOfResourceKeys>(
    resourceIdentifier: ResourceIdentifier<TResourceType>
  ) {
    return this.emitAndAcknowledgeResources('observeResource', {
      resourceIdentifier,
    });
  }

  subscribeToResource<TResourceType extends SessionCollectionMapOfResourceKeys>(
    resourceIdentifier: ResourceIdentifier<TResourceType>
  ) {
    return this.emitAndAcknowledgeSubscriptions('subscribeToResource', {
      resourceIdentifier,
    });
  }

  unsubscribeFromResource<
    TResourceType extends SessionCollectionMapOfResourceKeys
  >(resourceIdentifier: ResourceIdentifier<TResourceType>) {
    return this.emitAndAcknowledgeSubscriptions('unsubscribeFromResource', {
      resourceIdentifier,
    });
  }

  onResourceUpdated<TResourceType extends SessionCollectionMapOfResourceKeys>(
    fn: (
      r: ClientResource<TResourceType, ResourceCollectionMap[TResourceType]>
    ) => void
  ) {
    return this.pubsy.subscribe('updateResource', (r) => {
      fn(
        r as ClientResource<TResourceType, ResourceCollectionMap[TResourceType]>
      );
    });
  }

  onBroadcastedMsg<TEvent extends string, TMsg extends unknown>(
    fn: (data: { event: TEvent; msg: TMsg }) => void
  ) {
    return this.pubsy.subscribe('broadcastedMsg', ({ event, msg }) => {
      fn({
        event: event as TEvent,
        msg: msg as TMsg,
      });
    });
  }

  // TBD
  // onResourceRemoved<TResourceType extends SessionCollectionMapOfResourceKeys>(}

  // onResourceUpdated<TResourceType extends SessionCollectionMapOfResourceKeys>(
  //   resourceType: TResourceType,
  //   fn: (r: ResourceCollectionMap[TResourceType]) => void
  // ) {
  //   //TBD
  // }

  request<
    TReqType extends keyof RequestsCollectionMap,
    TReq = RequestsCollectionMap[TReqType]['0'],
    TRes = RequestsCollectionMap[TReqType]['1']
  >(k: TReqType, req: TReq): AsyncResult<TRes, unknown> {
    const reqName = String(k);
    const reqId = `${reqName}:${String(Math.random()).slice(-5)}`;

    return AsyncResult.toAsyncResult<TRes, unknown>(
      new Promise(async (resolve, reject) => {
        const connection = await this.socketConnection;

        this.logger.info('[ClientSdk]', reqId, 'Request:', reqName);

        connection.emit(
          'request',
          [reqName, req],
          withTimeout(
            (res: WsResponseResultPayload<TRes, unknown>) => {
              if (res.ok) {
                this.logger.info(
                  '[ClientSdk]',
                  reqId,
                  ' Response Ok:',
                  res.val
                );
                resolve(new Ok(res.val));
              } else {
                this.logger.warn(
                  '[ClientSdk]',
                  reqId,
                  ' Response Err:',
                  res.val
                );
                reject(new Err(res.val));
              }
            },
            () => {
              this.logger.warn('[ClientSdk]', reqId, ' Request Timeout:', req);
              reject(new Err('RequestTimeout')); // TODO This error could be typed better using a result error
            },
            this.config.waitForResponseMs
          )
        );
      })
    );
  }

  // broadcast<
  //   TReqType extends keyof RequestsCollectionMap,
  //   TReq = RequestsCollectionMap[TReqType]['0'],
  // >(k: TReqType, req: TReq): AsyncResult<void, unknown> {

  private emitAndAcknowledgeResources = <
    K extends keyof Pick<
      typeof SdkIO.msgs,
      | 'createResource'
      | 'observeResource'
      | 'getResource'
      | 'removeResource'
      | 'updateResource'
    >,
    TResourceType extends SessionCollectionMapOfResourceKeys,
    TReq extends SdkIO.Payloads[K]['req'],
    // TRawRes extends ResourceCollectionMap[TResourceType] = ResourceCollectionMap[TResourceType],
    TRawRes extends {
      type: TResourceType;
      item: ResourceCollectionMap[TResourceType];
      subscribers: SessionCollectionMap[TResourceType]['subscribers'];
    } = {
      type: TResourceType;
      item: ResourceCollectionMap[TResourceType];
      subscribers: SessionCollectionMap[TResourceType]['subscribers'];
    },
    TRes = ResourceCollectionMap[TResourceType]
  >(
    k: K,
    req: TReq
  ): AsyncResult<TRes, unknown> => {
    const reqId = `${k}:${String(Math.random()).slice(-5)}`;

    return AsyncResult.toAsyncResult<TRes, unknown>(
      new Promise(async (resolve, reject) => {
        const connection = await this.socketConnection;

        this.logger.info('[ClientSdk]', reqId, 'Resource Request:', req);

        connection.emit(
          SdkIO.msgs[k].req,
          req,
          withTimeout(
            (res: WsResponseResultPayload<TRawRes, unknown>) => {
              if (res.ok) {
                this.logger.info(
                  '[ClientSdk]',
                  reqId,
                  ' Resource Response Ok:',
                  res.val.item
                );
                resolve(new Ok(res.val.item as TRes));
              } else {
                this.logger.warn(
                  '[ClientSdk]',
                  reqId,
                  'Resource Response Err:',
                  res.val
                );
                reject(new Err(res.val));
              }
            },
            () => {
              this.logger.warn(
                '[ClientSdk]',
                reqId,
                'Resource Request Timeout:',
                req
              );
              reject(new Err('RequestTimeout')); // TODO This error could be typed better using a result error
            },
            this.config.waitForResponseMs
          )
        );
      })
    );
  };

  // private emitAndAcknowledgeMatches = <>() => {
    
  // }

  private emitAndAcknowledgeSubscriptions = <
    K extends keyof Pick<
      typeof SdkIO.msgs,
      'subscribeToResource' | 'unsubscribeFromResource'
    >,
    // TResourceType extends SessionCollectionMapOfResourceKeys,
    TReq extends SdkIO.Payloads[K]['req'],
    TRes = void
  >(
    k: K,
    req: Omit<TReq, 'resourceType'>
  ): AsyncResult<TRes, unknown> => {
    const reqId = `${k}:${String(Math.random()).slice(-5)}`;

    return AsyncResult.toAsyncResult<TRes, unknown>(
      new Promise(async (resolve, reject) => {
        const connection = await this.socketConnection;

        this.logger.info('[ClientSdk]', reqId, 'Request:', req);

        connection.emit(
          SdkIO.msgs[k].req,
          req,
          withTimeout(
            (res: WsResponseResultPayload<TRes, unknown>) => {
              if (res.ok) {
                this.logger.info('[ClientSdk]', reqId, 'Response Ok:', res);
                resolve(new Ok(res.val));
              } else {
                this.logger.warn('[ClientSdk]', reqId, 'Response Err:', res);
                reject(new Err(res.val));
              }
            },
            () => {
              this.logger.warn('[ClientSdk]', reqId, 'Request Timeout:', req);
              // TODO This error could be typed better using a result error
              reject(new Err('RequestTimeout'));
            },
            this.config.waitForResponseMs
          )
        );
      }).catch((e) => e) as any
    );
  };

  // Matches
  //  Matcheg

  createMatch(p: { matcher: string; playerCount: number }) {
    
  }

  observeMatch(matchId: SessionMatch['id']) {
    // return this.observeResource({
    //   resourceType: '$match',
    //   resourceId: matchId,
    // } as unknown as Parameters<typeof this.observeResource>[0]);
  }

  subscribeToMatch(matchId: SessionMatch['id']) {}

  joinMatch(matchId: SessionMatch['id']) {
    // return this.updateResource(
    //   {
    //     resourceType: '$match',
    //     resourceId: matchId,
    //   } as unknown as Parameters<typeof this.updateResource>[0],
    //   (prev: SessionMatch) => ({
    //     // players: [...prev.players, ]
    //   }) as Parameters<typeof this.updateResource>[1],
    // );
  }

  leaveMatch(matchId: SessionMatch['id']) {}
}

const withTimeout = (
  onSuccess: (...args: any[]) => void,
  onTimeout: () => void,
  timeout = 15 * 1000 // 15 sec
) => {
  let called = false;

  const timer = setTimeout(() => {
    if (called) return;
    called = true;
    onTimeout();
  }, timeout);

  return (...args: any[]) => {
    if (called) {
      return;
    }

    called = true;
    clearTimeout(timer);
    onSuccess(...args);
  };
};

const getDelayedRejectionPromise = <T>(delay = 15 * 1000, err = 'Timeout') =>
  new Promise<T>((_, reject) => {
    setTimeout(() => reject(err), delay); // wait for a long time to reconnect before failing
  });