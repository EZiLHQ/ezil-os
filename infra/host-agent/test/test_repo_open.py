import hashlib
import json
import os
import sys
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from ezil_host import edge
class RepositoryControl(unittest.TestCase):
    def test_digest_and_framing_before_any_forward(self):
        service = edge.Edge.__new__(edge.Edge)
        service.upstream_host = '127.0.0.1'
        body = b'{"repo":"https://github.ezil.work/team/a.git"}'
        head = Mock(method='POST', rest=body)
        head.get.side_effect = lambda key: [str(len(body))] if key == 'content-length' else []
        with patch.object(edge.http.client, 'HTTPConnection') as http, patch.object(edge, '_reply') as reply:
            service._repo_open(Mock(), head, '0' * 64, '')
            http.assert_not_called()
            self.assertEqual(reply.call_args.args[1], 409)
        head.get.side_effect = lambda key: ['chunked'] if key == 'transfer-encoding' else [str(len(body))]
        with patch.object(edge.http.client, 'HTTPConnection') as http, patch.object(edge, '_reply'):
            service._repo_open(Mock(), head, hashlib.sha256(body).hexdigest(), '')
            http.assert_not_called()
    def test_verified_body_uses_only_fixed_private_service(self):
        service = edge.Edge.__new__(edge.Edge); service.upstream_host = '127.0.0.1'
        body = b'{"repo":"https://github.ezil.work/team/a.git"}'
        head = Mock(method='POST', rest=body)
        head.get.side_effect = lambda key: [str(len(body))] if key == 'content-length' else []
        with patch.object(edge.http.client, 'HTTPConnection') as http, patch.object(edge, '_reply') as reply:
            http.return_value.getresponse.return_value.status = 200
            http.return_value.getresponse.return_value.read.return_value = b'{"ok":true}'
            service._repo_open(Mock(), head, hashlib.sha256(body).hexdigest(), '')
            http.assert_called_once_with('127.0.0.1', 9224, timeout=190)
            self.assertEqual(http.return_value.request.call_args.args[:3], ('POST', '/open', body))
            self.assertEqual(reply.call_args.args[1], 200)
if __name__ == '__main__': unittest.main()
