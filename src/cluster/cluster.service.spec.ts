const mockSocket = {
  bind: vi.fn(),
  on: vi.fn(),
  send: vi.fn(),
};

import { networkInterfaces } from 'os';
import { Node } from 'democracy';
import { Test, TestingModule } from '@nestjs/testing';
import { ClusterService } from './cluster.service';
import { ConfigModule } from '../config/config.module';
import { ClusterConfig } from './cluster.config';
import { ConfigService } from '../config/config.service';
import c from 'config';
import mdns from 'mdns';

import { Mock, vi } from 'vitest';

vi.mock('os');
vi.mock('dgram', () => {
  return {
    createSocket: vi.fn().mockReturnValue(mockSocket),
  };
});
vi.useFakeTimers();

const mockMdns = vi.mocked(mdns);

describe('ClusterService', () => {
  let service: ClusterService;
  const mockConfig = { ...new ClusterConfig(), weight: 50 };
  const configService = {
    get: vi.fn().mockImplementation((key: string) => {
      return key === 'cluster' ? mockConfig : c.get(key);
    }),
  };

  beforeAll(async () => {
    (networkInterfaces as Mock).mockReturnValue({
      lo: [
        {
          address: '127.0.0.1',
          family: 'IPv4',
          internal: true,
        },
      ],
      eth0: [
        {
          address: '192.168.1.108',
          family: 'IPv4',
          internal: false,
        },
        {
          address: 'fe80::a00:27ff:fe4e:66a1',
          family: 'IPv6',
          internal: false,
        },
      ],
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [ClusterService],
    })
      .overrideProvider(ConfigService)
      .useValue(configService)
      .compile();

    service = module.get<ClusterService>(ClusterService);
  });

  it('should determine the local IP', () => {
    expect(mockSocket.bind).toHaveBeenCalledWith(
      '6425',
      '192.168.1.108',
      expect.any(Function)
    );
  });

  it('should start advertising room-assistant via Bonjour', () => {
    service.onApplicationBootstrap();
    expect(mockMdns.createAdvertisement).toHaveBeenCalledWith(
      { name: 'room-assistant' },
      6425,
      {
        networkInterface: undefined,
      }
    );
    expect(mockMdns.createAdvertisement).toHaveBeenCalledWith(
      { name: 'room-asst-api' },
      6415,
      {
        networkInterface: undefined,
      }
    );
    expect(mockMdns.createBrowser).toHaveBeenCalledWith(
      { name: 'room-assistant' },
      expect.anything()
    );

    const mockBrowser = mockMdns.createBrowser.mock.results[0].value;
    expect(mockBrowser.start).toHaveBeenCalled();

    const mockClusterAdvertisement =
      mockMdns.createAdvertisement.mock.results[0].value;
    expect(mockClusterAdvertisement.start).toHaveBeenCalled();

    const mockApiAdvertisement =
      mockMdns.createAdvertisement.mock.results[1].value;
    expect(mockApiAdvertisement.start).toHaveBeenCalled();
  });

  it('should not advertise the instance if auto discovery has been turned off', () => {
    mockConfig.autoDiscovery = false;

    service.onApplicationBootstrap();
    expect(mockMdns.createAdvertisement).not.toHaveBeenCalled();
    expect(mockMdns.createBrowser).not.toHaveBeenCalled();
  });

  it('should ignore the quorum if it is not configured', () => {
    vi.spyOn(service, 'nodes').mockReturnValue({
      abc: {
        state: 'leader',
      } as Node,
    });

    expect(service.quorumReached()).toBeTruthy();
  });

  it('should consider the quorum reached if as many nodes are connected', () => {
    vi.spyOn(service, 'nodes').mockReturnValue({
      abc: {
        state: 'leader',
      } as Node,
      def: {
        state: 'citizen',
      } as Node,
    });
    mockConfig.quorum = 2;

    expect(service.quorumReached()).toBeTruthy();
  });

  it('should not consider the quorum reached if less nodes are connected', () => {
    vi.spyOn(service, 'nodes').mockReturnValue({
      abc: {
        state: 'leader',
      } as Node,
    });
    mockConfig.quorum = 2;

    expect(service.quorumReached()).toBeFalsy();
  });

  it('should not consider removed nodes for the quorum', () => {
    vi.spyOn(service, 'nodes').mockReturnValue({
      abc: {
        state: 'removed',
      } as Node,
      def: {
        state: 'leader',
      } as Node,
    });
    mockConfig.quorum = 2;

    expect(service.quorumReached()).toBeFalsy();
  });

  it('should be the majority leader if the quorum is reached', () => {
    vi.spyOn(service, 'quorumReached').mockReturnValue(true);
    vi.spyOn(service, 'isLeader').mockReturnValue(true);

    expect(service.isMajorityLeader()).toBeTruthy();
  });

  it('should not be the majority leader if the quorum is not reached', () => {
    vi.spyOn(service, 'quorumReached').mockReturnValue(false);
    vi.spyOn(service, 'isLeader').mockReturnValue(true);

    expect(service.isMajorityLeader()).toBeFalsy();
  });

  it('should handle cluster leader conflicts', () => {
    mockSocket.bind.mock.calls[0][2]();
    const socketCallback = mockSocket.on.mock.calls[0][1];

    const msg1 = Buffer.from(
      JSON.stringify({
        event: 'hello',
        id: 'node1',
        weight: 60,
        state: 'leader',
        channels: [],
        source: '127.0.0.1:6425',
      }),
      'utf8'
    );
    const msg2 = Buffer.from(
      JSON.stringify({
        event: 'hello',
        id: 'node2',
        weight: 55,
        state: 'leader',
        channels: [],
        source: '127.0.0.1:6426',
      }),
      'utf8'
    );

    socketCallback(msg1);
    socketCallback(msg2);

    const leaders = Object.entries(service.nodes()).filter(
      (node) => node[1].state === 'leader'
    );

    expect(service.leader().id).toBe('node1');
    expect(leaders).toHaveLength(1);
  });
});
