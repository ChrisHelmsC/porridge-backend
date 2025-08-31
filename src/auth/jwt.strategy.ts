import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(configService: ConfigService) {
		super({
			jwtFromRequest: ExtractJwt.fromExtractors([
				(req: any) => {
					if (req && req.cookies && req.cookies['access_token']) {
						return req.cookies['access_token'];
					}
					return null;
				},
				ExtractJwt.fromAuthHeaderAsBearerToken(),
			]),
			ignoreExpiration: false,
			secretOrKey: configService.get('JWT_SECRET') || 'dev_secret_change_me',
		});
	}

	async validate(payload: any) {
		return { userId: payload.sub, username: payload.username };
	}
}
