import { Body, Controller, Post, Request, UseGuards, Res, Get, HttpCode, Req, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './local.guard';
import { UsersService } from '../users/users.service';
import { IsString, MinLength, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from './jwt.guard';

class SignupDto {
	@IsString()
	@MinLength(3)
	@MaxLength(128)
	email: string;

	@IsString()
	@MinLength(6)
	@MaxLength(128)
	password: string;
}

class LoginDto {
	@IsString()
	email: string;

	@IsString()
	password: string;
}

@Controller('auth')
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly usersService: UsersService,
		private readonly config: ConfigService,
	) {}

	private cookieOptions() {
		const secure = this.config.get<string>('NODE_ENV') === 'production' || this.config.get<string>('COOKIE_SECURE') === 'true';
		return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };
	}

	@Post('signup')
	async signup(@Body() body: SignupDto, @Res({ passthrough: true }) res: Response) {
		if (!body.email.includes('@')) throw new BadRequestException('Email is invalid');
		const user = await this.usersService.createUser(body.email, body.password);
		const tokens = await this.authService.login({ id: user.id, email: user.email, tokenVersion: user.tokenVersion });
		const opts = this.cookieOptions();
		res.cookie('access_token', tokens.access_token, opts);
		res.cookie('refresh_token', tokens.refresh_token, opts);
		return { message: 'signed_in' };
	}

	@UseGuards(LocalAuthGuard)
	@Post('login')
	@HttpCode(200)
	async login(@Request() req: any, @Body() _body: LoginDto, @Res({ passthrough: true }) res: Response) {
		const tokens = await this.authService.login({ id: req.user.id, email: req.user.email, tokenVersion: req.user.tokenVersion ?? 0 });
		const opts = this.cookieOptions();
		res.cookie('access_token', tokens.access_token, opts);
		res.cookie('refresh_token', tokens.refresh_token, opts);
		return { message: 'signed_in' };
	}

	@UseGuards(JwtAuthGuard)
	@Get('me')
	async me(@Request() req: any) {
		return { id: req.user.userId, email: req.user.email };
	}

	@Post('logout')
	@HttpCode(200)
	async logout(@Res({ passthrough: true }) res: Response) {
		res.clearCookie('access_token');
		res.clearCookie('refresh_token');
		return { message: 'signed_out' };
	}

	@Post('refresh')
	@HttpCode(200)
	async refresh(@Req() req: any, @Res({ passthrough: true }) res: Response) {
		const token = req?.cookies?.['refresh_token'] || (req?.headers?.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
		if (!token) throw new UnauthorizedException('No refresh token');
		try {
			const decoded: any = await (this.authService as any)['jwtService'].verifyAsync(token, {});
			const userId = decoded?.sub;
			const tokenVersion = decoded?.tokenVersion ?? 0;
			const user = await this.usersService.findById(userId);
			if (!user || !user.refreshTokenHash) throw new UnauthorizedException('Invalid refresh token');
			const ok = await require('bcrypt').compare(token, user.refreshTokenHash);
			if (!ok) throw new UnauthorizedException('Invalid refresh token');
			const tokens = await this.authService.rotateRefresh(userId, tokenVersion);
			const opts = this.cookieOptions();
			res.cookie('access_token', tokens.access_token, opts);
			res.cookie('refresh_token', tokens.refresh_token, opts);
			return { message: 'refreshed' };
		} catch (e) {
			res.clearCookie('access_token');
			res.clearCookie('refresh_token');
			throw new UnauthorizedException('Refresh failed');
		}
	}
}
